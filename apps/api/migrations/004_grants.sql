-- Least-privilege grants for the runtime role. The runtime role owns nothing, has no BYPASSRLS, and
-- can only touch what is listed here.
revoke all on all tables in schema public from public;
revoke all on all functions in schema public from public;
grant usage on schema public to verinum_app;

grant select, insert, update, delete on users, sessions, oauth_identities, email_tokens to verinum_app;
grant select, update on workspaces to verinum_app;
grant select, insert, update, delete on memberships, invitations to verinum_app;
grant select, insert, update, delete on datasets, dataset_versions, dashboards, conversations, messages to verinum_app;
grant select, insert, delete on usage_events to verinum_app;
grant select, insert on audit_logs to verinum_app;
grant select, insert on jobs to verinum_app;
grant usage on all sequences in schema public to verinum_app;

grant execute on function app_user_id(), app_workspace_id() to verinum_app;
grant execute on function create_workspace(text, text, text), accept_invitation(bytea), invitation_preview(bytea), delete_workspace(uuid) to verinum_app;
grant execute on function job_claim(text, text[]), job_heartbeat(uuid, text, jsonb), job_finish(uuid, text, jsonb),
  job_fail(uuid, text, text, boolean), job_reap(integer), job_cancel(uuid) to verinum_app;
grant execute on function admin_overview(), admin_workspaces(text, integer, integer), admin_jobs(text, integer),
  admin_audit(integer), admin_set_workspace_plan(uuid, text) to verinum_app;
