-- Datasets and their immutable versions. Every child table carries workspace_id and a composite
-- foreign key to (workspace_id, id), so a row can never reference another tenant's parent.

create type dataset_status as enum ('queued', 'processing', 'ready', 'failed', 'deleting');

create table datasets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  status dataset_status not null default 'queued',
  current_version_id uuid,
  source_name text,
  source_format text,
  is_demo boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  error jsonb,
  unique (workspace_id, id)
);
create index datasets_ws_idx on datasets (workspace_id, created_at desc);

create table dataset_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  dataset_id uuid not null,
  version integer not null,
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  storage_original text not null,
  storage_frame text,
  byte_size bigint not null default 0,
  row_count integer,
  column_count integer,
  table_index integer not null default 0,
  table_name text,
  available_tables jsonb not null default '[]'::jsonb,
  options jsonb not null default '{}'::jsonb,
  profile jsonb,
  quality jsonb,
  transformations jsonb,
  suggestions jsonb,
  insights jsonb,
  plan jsonb,
  document jsonb,
  warnings jsonb not null default '[]'::jsonb,
  analysis_version text,
  error jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (dataset_id, version),
  foreign key (workspace_id, dataset_id) references datasets (workspace_id, id) on delete cascade
);
create index dataset_versions_ds_idx on dataset_versions (dataset_id, version desc);

alter table datasets add constraint datasets_current_version_fk
  foreign key (current_version_id) references dataset_versions (id) on delete set null (current_version_id) deferrable initially deferred;

create table dashboards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  dataset_id uuid not null,
  name text not null default 'Overview',
  widgets jsonb not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, dataset_id) references datasets (workspace_id, id) on delete cascade
);
create index dashboards_ds_idx on dashboards (dataset_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  dataset_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, dataset_id) references datasets (workspace_id, id) on delete cascade
);
create index conversations_ds_idx on conversations (workspace_id, dataset_id, user_id, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  mode text,
  sources jsonb,
  charts jsonb,
  grounding jsonb,
  facts jsonb,
  warnings jsonb,
  follow_ups jsonb,
  usage jsonb,
  provider text,
  model text,
  feedback smallint check (feedback in (-1, 1)),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, conversation_id) references conversations (workspace_id, id) on delete cascade
);
create index messages_conv_idx on messages (conversation_id, created_at);

create table usage_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null,
  quantity integer not null default 1,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index usage_events_idx on usage_events (workspace_id, kind, created_at);

-- Append-only audit trail. workspace_id is null for platform-level events (sign-in, registration).
create table audit_logs (
  id bigserial primary key,
  -- deliberately no foreign keys: the trail outlives the workspace and the user
  workspace_id uuid,
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb not null default '{}'::jsonb,
  ip text,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_ws_idx on audit_logs (workspace_id, created_at desc);
create index audit_actor_idx on audit_logs (actor_id, created_at desc);
create function audit_immutable() returns trigger language plpgsql as $$ begin raise exception 'audit_logs is append-only'; end $$;
create trigger audit_no_update before update or delete on audit_logs for each row execute function audit_immutable();

-- ---- row-level security: every tenant table ----
do $$
declare t text;
begin
  foreach t in array array['datasets', 'dataset_versions', 'dashboards', 'conversations', 'messages', 'usage_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id())', t);
  end loop;
end $$;

alter table audit_logs enable row level security;
create policy audit_select on audit_logs for select
  using (workspace_id = app_workspace_id() or (workspace_id is null and actor_id = app_user_id()));
create policy audit_insert on audit_logs for insert
  with check (workspace_id is null or workspace_id = app_workspace_id());
