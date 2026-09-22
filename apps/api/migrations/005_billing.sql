-- Billing webhooks arrive without a user or workspace context, so they run through narrow
-- SECURITY DEFINER functions instead of widening the runtime role's table access.

create table billing_events (
  event_id text primary key,
  provider text not null,
  type text not null,
  received_at timestamptz not null default now()
);
alter table billing_events enable row level security;  -- no policy: unreachable except through the function below

-- true when the event is new (process it), false when it was already handled (idempotent webhooks)
create function billing_record_event(p_event text, p_provider text, p_type text) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into billing_events (event_id, provider, type) values (p_event, p_provider, p_type) on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create function billing_workspace_for_customer(p_customer text) returns uuid
  language sql security definer stable set search_path = public, pg_temp as $$
  select id from workspaces where billing ->> 'customerId' = p_customer and deleted_at is null limit 1
$$;

-- Applies a plan/billing change. p_plan may be null to leave the plan unchanged.
create function billing_apply(p_workspace uuid, p_plan text, p_billing jsonb) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update workspaces set plan_id = coalesce(p_plan, plan_id), billing = billing || coalesce(p_billing, '{}'::jsonb)
  where id = p_workspace and deleted_at is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function billing_record_event(text, text, text), billing_workspace_for_customer(text), billing_apply(uuid, text, jsonb) from public;
grant execute on function billing_record_event(text, text, text), billing_workspace_for_customer(text), billing_apply(uuid, text, jsonb) to verinum_app;
