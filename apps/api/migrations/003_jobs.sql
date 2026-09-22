-- Postgres-backed job queue. Workers claim with FOR UPDATE SKIP LOCKED, hold a lease renewed by
-- heartbeats, and a reaper requeues jobs whose worker vanished. Claiming crosses tenants by design,
-- so it runs through SECURITY DEFINER functions; everything a job then does to tenant data runs in
-- that job's own tenant context (RLS applies).

create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  progress jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  dedupe_key text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_claim_idx on jobs (run_at, created_at) where status = 'queued';
create index jobs_ws_idx on jobs (workspace_id, created_at desc);
create unique index jobs_dedupe_uq on jobs (workspace_id, dedupe_key) where dedupe_key is not null and status in ('queued', 'running');

alter table jobs enable row level security;
create policy tenant_isolation on jobs using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());

create function job_claim(p_worker text, p_kinds text[]) returns setof jobs
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update jobs j set status = 'running', locked_by = p_worker, locked_at = now(), heartbeat_at = now(), attempts = j.attempts + 1
  where j.id = (
    select id from jobs where status = 'queued' and run_at <= now() and kind = any (p_kinds)
    order by run_at, created_at for update skip locked limit 1)
  returning j.*;
end $$;

create function job_heartbeat(p_id uuid, p_worker text, p_progress jsonb) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update jobs set heartbeat_at = now(), progress = coalesce(p_progress, progress)
  where id = p_id and locked_by = p_worker and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

create function job_finish(p_id uuid, p_worker text, p_result jsonb) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update jobs set status = 'succeeded', result = p_result, finished_at = now(), heartbeat_at = now(),
    progress = jsonb_set(progress, '{pct}', '100')
  where id = p_id and locked_by = p_worker and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Failure: retry with backoff while attempts remain, otherwise fail permanently.
create function job_fail(p_id uuid, p_worker text, p_error text, p_retry boolean) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare j jobs%rowtype;
begin
  select * into j from jobs where id = p_id and locked_by = p_worker and status = 'running' for update;
  if not found then return 'lost'; end if;
  if p_retry and j.attempts < j.max_attempts then
    update jobs set status = 'queued', locked_by = null, locked_at = null, error = p_error,
      run_at = now() + (power(2, j.attempts) * interval '5 seconds') where id = p_id;
    return 'retry';
  end if;
  update jobs set status = 'failed', error = p_error, finished_at = now() where id = p_id;
  return 'failed';
end $$;

-- Requeue jobs whose worker stopped heartbeating; fail those out of attempts.
create function job_reap(p_lease_seconds integer) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with stale as (
    select id, attempts, max_attempts from jobs
    where status = 'running' and heartbeat_at < now() - make_interval(secs => p_lease_seconds) for update skip locked)
  update jobs j set
    status = case when s.attempts >= s.max_attempts then 'failed'::job_status else 'queued'::job_status end,
    locked_by = null, locked_at = null,
    error = case when s.attempts >= s.max_attempts then 'The worker stopped responding.' else j.error end,
    finished_at = case when s.attempts >= s.max_attempts then now() else null end
  from stale s where j.id = s.id;
  get diagnostics n = row_count;
  return n;
end $$;

create function job_cancel(p_id uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update jobs set status = 'cancelled', finished_at = now()
  where id = p_id and workspace_id = app_workspace_id() and status in ('queued', 'running');
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---- platform administration: metadata aggregates only, never tenant content ----
create function assert_platform_admin() returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from users where id = app_user_id() and is_platform_admin and disabled_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create function admin_overview() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_platform_admin();
  return jsonb_build_object(
    'users', (select count(*) from users),
    'workspaces', (select count(*) from workspaces),
    'datasets', (select count(*) from datasets),
    'jobsQueued', (select count(*) from jobs where status = 'queued'),
    'jobsRunning', (select count(*) from jobs where status = 'running'),
    'jobsFailed24h', (select count(*) from jobs where status = 'failed' and finished_at > now() - interval '24 hours'),
    'aiMessages30d', (select coalesce(sum(quantity), 0) from usage_events where kind = 'ai_message' and created_at > now() - interval '30 days'),
    'plans', (select coalesce(jsonb_object_agg(plan_id, c), '{}'::jsonb) from (select plan_id, count(*) c from workspaces group by plan_id) p));
end $$;

create function admin_workspaces(p_query text, p_limit integer, p_offset integer)
  returns table (id uuid, name text, slug text, plan_id text, created_at timestamptz, members bigint, datasets bigint, ai_messages_30d bigint)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_platform_admin();
  return query
  select w.id, w.name, w.slug, w.plan_id, w.created_at,
    (select count(*) from memberships m where m.workspace_id = w.id),
    (select count(*) from datasets d where d.workspace_id = w.id),
    (select coalesce(sum(u.quantity), 0)::bigint from usage_events u where u.workspace_id = w.id and u.kind = 'ai_message' and u.created_at > now() - interval '30 days')
  from workspaces w
  where p_query is null or w.name ilike '%' || p_query || '%' or w.slug ilike '%' || p_query || '%'
  order by w.created_at desc limit least(p_limit, 200) offset p_offset;
end $$;

create function admin_jobs(p_status text, p_limit integer)
  returns table (id uuid, workspace_id uuid, kind text, status job_status, attempts integer, error text, created_at timestamptz, finished_at timestamptz)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_platform_admin();
  return query select j.id, j.workspace_id, j.kind, j.status, j.attempts, j.error, j.created_at, j.finished_at
    from jobs j where p_status is null or j.status::text = p_status order by j.created_at desc limit least(p_limit, 200);
end $$;

create function admin_audit(p_limit integer)
  returns table (id bigint, workspace_id uuid, actor_id uuid, action text, target_type text, target_id text, created_at timestamptz)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_platform_admin();
  return query select a.id, a.workspace_id, a.actor_id, a.action, a.target_type, a.target_id, a.created_at
    from audit_logs a order by a.id desc limit least(p_limit, 500);
end $$;

create function admin_set_workspace_plan(p_id uuid, p_plan text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_platform_admin();
  update workspaces set plan_id = p_plan where id = p_id;
end $$;
