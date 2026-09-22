-- Verinum core schema: identity, workspaces, memberships.
-- Tenant isolation is enforced in three layers: (1) the API resolves the workspace from a verified
-- membership, (2) every query filters by workspace_id, (3) Postgres row-level security below
-- (RLS is enabled on every tenant table; the runtime role owns nothing and has no BYPASSRLS. The only
-- cross-tenant paths are the SECURITY DEFINER functions, which are enumerated in docs/SECURITY.md).

-- Session context helpers. Unset → NULL → no rows are visible (fail closed).
create function app_user_id() returns uuid language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create function app_workspace_id() returns uuid language sql stable
  as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text,
  name text not null default '',
  email_verified_at timestamptz,
  is_platform_admin boolean not null default false,
  disabled_at timestamptz,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  constraint users_email_normalised check (email = lower(btrim(email)))
);
create unique index users_email_uq on users (email);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ip text,
  user_agent text,
  revoked_at timestamptz
);
create index sessions_user_idx on sessions (user_id);

create table oauth_identities (
  provider text not null,
  subject text not null,
  user_id uuid not null references users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);

create table email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('verify', 'reset')),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create type workspace_role as enum ('owner', 'admin', 'analyst', 'viewer');

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  plan_id text not null default 'free',
  billing jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  role workspace_role not null check (role <> 'owner'),
  token_hash bytea not null unique,
  invited_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz
);
create index invitations_ws_idx on invitations (workspace_id);
create unique index invitations_open_uq on invitations (workspace_id, email) where accepted_at is null and revoked_at is null;

-- ---- row-level security ----
alter table workspaces enable row level security;
alter table memberships enable row level security;
alter table invitations enable row level security;

-- a user sees their own memberships, and everyone's memberships in the workspace they are acting in
create policy memberships_select on memberships for select
  using (user_id = app_user_id() or workspace_id = app_workspace_id());
create policy memberships_write on memberships for all
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());

create policy workspaces_select on workspaces for select
  using (id = app_workspace_id()
         or exists (select 1 from memberships m where m.workspace_id = workspaces.id and m.user_id = app_user_id()));
create policy workspaces_update on workspaces for update
  using (id = app_workspace_id()) with check (id = app_workspace_id());

create policy invitations_all on invitations for all
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());

-- Workspace creation is atomic and privileged: the creator becomes the owner.
create function create_workspace(p_name text, p_slug text, p_plan text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if app_user_id() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into workspaces (name, slug, plan_id, created_by) values (p_name, p_slug, p_plan, app_user_id()) returning id into v_id;
  insert into memberships (workspace_id, user_id, role) values (v_id, app_user_id(), 'owner');
  return v_id;
end $$;

-- Accepting an invitation: the token proves possession; the invited email must match the user's.
create function accept_invitation(p_token_hash bytea) returns table (workspace_id uuid, role workspace_role)
  language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare inv invitations%rowtype; usr users%rowtype;
begin
  if app_user_id() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into usr from users where id = app_user_id();
  select * into inv from invitations where token_hash = p_token_hash and accepted_at is null and revoked_at is null and expires_at > now() for update;
  if not found then raise exception 'invitation_invalid' using errcode = 'P0001'; end if;
  if inv.email <> usr.email then raise exception 'invitation_email_mismatch' using errcode = 'P0001'; end if;
  insert into memberships (workspace_id, user_id, role) values (inv.workspace_id, usr.id, inv.role)
    on conflict (workspace_id, user_id) do nothing;
  update invitations set accepted_at = now() where id = inv.id;
  return query select inv.workspace_id, inv.role;
end $$;

-- Preview of an invitation (workspace name, role) for the accept screen; reveals nothing else.
create function invitation_preview(p_token_hash bytea) returns table (workspace_name text, role workspace_role, email text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select w.name, i.role, i.email from invitations i join workspaces w on w.id = i.workspace_id
  where i.token_hash = p_token_hash and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
$$;

-- Deleting a workspace removes it (and, by cascade, everything in it) — owner-checked in the API.
create function delete_workspace(p_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from memberships where workspace_id = p_id and user_id = app_user_id() and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from workspaces where id = p_id;
end $$;
