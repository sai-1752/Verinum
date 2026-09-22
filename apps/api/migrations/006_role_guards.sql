-- Defence in depth for role escalation: even a buggy or compromised API route cannot promote a
-- member, invite an admin as an admin, change a workspace's plan, or grant platform-admin, because
-- the database itself refuses. The API applies the same rules (permissions.ts) to give friendly errors.

create function app_role_in(p_workspace uuid) returns workspace_role
  language sql stable security definer set search_path = public, pg_temp as $$
  select role from memberships where workspace_id = p_workspace and user_id = app_user_id()
$$;
revoke all on function app_role_in(uuid) from public;
grant execute on function app_role_in(uuid) to verinum_app;

-- may the acting user manage a membership/invitation with the given role in this workspace?
create function app_can_manage(p_workspace uuid, p_target workspace_role) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select case app_role_in(p_workspace)
    when 'owner' then true
    when 'admin' then p_target in ('analyst', 'viewer')
    else false end
$$;
revoke all on function app_can_manage(uuid, workspace_role) from public;
grant execute on function app_can_manage(uuid, workspace_role) to verinum_app;

drop policy memberships_write on memberships;
create policy memberships_insert on memberships for insert
  with check (workspace_id = app_workspace_id() and app_can_manage(workspace_id, role));
create policy memberships_update on memberships for update
  using (workspace_id = app_workspace_id() and app_can_manage(workspace_id, role))
  with check (workspace_id = app_workspace_id() and app_can_manage(workspace_id, role));
create policy memberships_delete on memberships for delete
  using (workspace_id = app_workspace_id() and (user_id = app_user_id() or app_can_manage(workspace_id, role)));

drop policy invitations_all on invitations;
create policy invitations_all on invitations for all
  using (workspace_id = app_workspace_id() and app_can_manage(workspace_id, role))
  with check (workspace_id = app_workspace_id() and app_can_manage(workspace_id, role));

-- only owners/admins may edit workspace settings, and never the plan or billing columns
drop policy workspaces_update on workspaces;
create policy workspaces_update on workspaces for update
  using (id = app_workspace_id() and app_role_in(id) in ('owner', 'admin'))
  with check (id = app_workspace_id());
revoke update on workspaces from verinum_app;
grant update (name, settings) on workspaces to verinum_app;

-- the runtime role can never make anyone a platform admin
revoke update on users from verinum_app;
grant update (email, password_hash, name, email_verified_at, failed_logins, locked_until, last_login_at, disabled_at) on users to verinum_app;
