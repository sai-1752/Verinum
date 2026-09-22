import type { Deps } from "../context";
import { audit } from "../audit";
import type { ReqMeta } from "../auth/service";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors";
import { canManageRole, type Role } from "../permissions";
import { enforce } from "../plans";
import { normalizeEmail, randomToken, sha256 } from "../security/crypto";
import { templates } from "../mail";
import { inWorkspace, isUuid, type WorkspaceCtx } from "./service";

const INVITE_TTL_DAYS = 7;

export async function listMembers(deps: Deps, ctx: WorkspaceCtx) {
  return inWorkspace(deps, ctx, async (q) => (await q.query<{ user_id: string; role: Role; created_at: Date; email: string; name: string }>(
    `select m.user_id, m.role, m.created_at, u.email, u.name from memberships m join users u on u.id = m.user_id
     where m.workspace_id = $1 order by m.created_at`, [ctx.workspaceId])).rows.map((r) => ({ userId: r.user_id, role: r.role, joinedAt: r.created_at, email: r.email, name: r.name })));
}

export async function listInvitations(deps: Deps, ctx: WorkspaceCtx) {
  return inWorkspace(deps, ctx, async (q) => (await q.query<{ id: string; email: string; role: Role; created_at: Date; expires_at: Date }>(
    "select id, email, role, created_at, expires_at from invitations where workspace_id = $1 and accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc", [ctx.workspaceId]))
    .rows.map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at })));
}

export async function invite(deps: Deps, ctx: WorkspaceCtx, input: { email: string; role: Role }, inviterName: string, meta: ReqMeta) {
  if (input.role === "owner") throw badRequest("Invite as admin, analyst or viewer. Ownership can be transferred from the members list.");
  if (!canManageRole(ctx.role, input.role)) throw forbidden("You can't invite someone with that role.");
  const email = normalizeEmail(input.email);
  const token = randomToken(32);
  await inWorkspace(deps, ctx, async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`members:${ctx.workspaceId}`]);
    const already = await q.query("select 1 from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 and u.email = $2", [ctx.workspaceId, email]);
    if (already.rowCount) throw conflict("That person is already a member of this workspace.", "already_member");
    const counts = (await q.query<{ n: number }>(
      "select ((select count(*) from memberships where workspace_id = $1) + (select count(*) from invitations where workspace_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()))::int n", [ctx.workspaceId])).rows[0]!;
    enforce(ctx.plan, "maxMembers", counts.n, 1, "members (including pending invitations)");
    // re-inviting replaces the earlier open invitation
    await q.query("update invitations set revoked_at = now() where workspace_id = $1 and email = $2 and accepted_at is null and revoked_at is null", [ctx.workspaceId, email]);
    await q.query("insert into invitations (workspace_id, email, role, token_hash, invited_by, expires_at) values ($1,$2,$3,$4,$5, now() + make_interval(days => $6))",
      [ctx.workspaceId, email, input.role, sha256(token), ctx.userId, INVITE_TTL_DAYS]);
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "member.invite", targetType: "invitation", targetId: email, meta: { role: input.role }, ip: meta.ip, requestId: meta.requestId });
  });
  await deps.mailer.send({ to: email, ...templates.invitation(inviterName || "A teammate", ctx.workspace.name, input.role, `${deps.config.PUBLIC_WEB_URL}/accept-invite?token=${token}`) });
}

export async function revokeInvitation(deps: Deps, ctx: WorkspaceCtx, id: string, meta: ReqMeta) {
  if (!isUuid(id)) throw notFound("Invitation");
  await inWorkspace(deps, ctx, async (q) => {
    const r = await q.query("update invitations set revoked_at = now() where id = $1 and workspace_id = $2 and accepted_at is null and revoked_at is null", [id, ctx.workspaceId]);
    if (!r.rowCount) throw notFound("Invitation");
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "member.invite_revoked", targetType: "invitation", targetId: id, ip: meta.ip, requestId: meta.requestId });
  });
}

export async function previewInvitation(deps: Deps, token: string) {
  const r = await deps.db.query<{ workspace_name: string; role: Role; email: string }>("select * from invitation_preview($1)", [sha256(token)]);
  if (!r.rows[0]) throw unprocessable("This invitation is invalid or has expired.", "invalid_invitation");
  return { workspaceName: r.rows[0].workspace_name, role: r.rows[0].role, email: r.rows[0].email };
}

export async function acceptInvitation(deps: Deps, userId: string, token: string, meta: ReqMeta): Promise<{ workspaceId: string; role: Role }> {
  try {
    return await deps.db.tx({ userId }, async (q) => {
      const r = (await q.query<{ workspace_id: string; role: Role }>("select * from accept_invitation($1)", [sha256(token)])).rows[0]!;
      // membership now exists, so the joiner may act inside the workspace: record the event in its own trail
      await q.query("select set_config('app.workspace_id', $1, true)", [r.workspace_id]);
      await audit(q, { workspaceId: r.workspace_id, actorId: userId, action: "member.joined", targetType: "user", targetId: userId, meta: { role: r.role }, ip: meta.ip, requestId: meta.requestId });
      return { workspaceId: r.workspace_id, role: r.role };
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("invitation_email_mismatch")) throw forbidden("This invitation was sent to a different email address. Sign in with the invited address.");
    if (msg.includes("invitation_invalid")) throw unprocessable("This invitation is invalid or has expired.", "invalid_invitation");
    throw e;
  }
}

async function ownerCount(q: { query: <R extends object>(sql: string, p?: unknown[]) => Promise<{ rows: R[] }> }, workspaceId: string): Promise<number> {
  return (await q.query<{ n: number }>("select count(*)::int n from memberships where workspace_id = $1 and role = 'owner'", [workspaceId])).rows[0]!.n;
}

export async function changeRole(deps: Deps, ctx: WorkspaceCtx, targetUserId: string, role: Role, meta: ReqMeta) {
  if (!isUuid(targetUserId)) throw notFound("Member");
  await inWorkspace(deps, ctx, async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`members:${ctx.workspaceId}`]);
    const cur = (await q.query<{ role: Role }>("select role from memberships where workspace_id = $1 and user_id = $2", [ctx.workspaceId, targetUserId])).rows[0];
    if (!cur) throw notFound("Member");
    if (!canManageRole(ctx.role, cur.role) || !canManageRole(ctx.role, role)) throw forbidden("You can't change that member's role.");
    if (cur.role === "owner" && role !== "owner" && (await ownerCount(q, ctx.workspaceId)) <= 1) throw conflict("A workspace needs at least one owner. Make someone else an owner first.", "last_owner");
    await q.query("update memberships set role = $3 where workspace_id = $1 and user_id = $2", [ctx.workspaceId, targetUserId, role]);
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "member.role_changed", targetType: "user", targetId: targetUserId, meta: { from: cur.role, to: role }, ip: meta.ip, requestId: meta.requestId });
  });
}

/** Removes a member, or lets a member leave. */
export async function removeMember(deps: Deps, ctx: WorkspaceCtx, targetUserId: string, meta: ReqMeta) {
  if (!isUuid(targetUserId)) throw notFound("Member");
  await inWorkspace(deps, ctx, async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`members:${ctx.workspaceId}`]);
    const cur = (await q.query<{ role: Role }>("select role from memberships where workspace_id = $1 and user_id = $2", [ctx.workspaceId, targetUserId])).rows[0];
    if (!cur) throw notFound("Member");
    const self = targetUserId === ctx.userId;
    if (!self && !canManageRole(ctx.role, cur.role)) throw forbidden("You can't remove that member.");
    if (cur.role === "owner" && (await ownerCount(q, ctx.workspaceId)) <= 1) throw conflict("A workspace needs at least one owner.", "last_owner");
    await q.query("delete from memberships where workspace_id = $1 and user_id = $2", [ctx.workspaceId, targetUserId]);
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: self ? "member.left" : "member.removed", targetType: "user", targetId: targetUserId, ip: meta.ip, requestId: meta.requestId });
  });
}

export async function renameWorkspace(deps: Deps, ctx: WorkspaceCtx, name: string, meta: ReqMeta) {
  await inWorkspace(deps, ctx, async (q) => {
    await q.query("update workspaces set name = $2 where id = $1", [ctx.workspaceId, name]);
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "workspace.rename", targetType: "workspace", targetId: ctx.workspaceId, ip: meta.ip, requestId: meta.requestId });
  });
}

export async function deleteWorkspace(deps: Deps, ctx: WorkspaceCtx, confirmName: string, meta: ReqMeta) {
  if (confirmName.trim() !== ctx.workspace.name) throw badRequest("Type the workspace name exactly to confirm.");
  await deps.db.tx({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (q) => {
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "workspace.delete", targetType: "workspace", targetId: ctx.workspaceId, meta: { name: ctx.workspace.name }, ip: meta.ip, requestId: meta.requestId });
    await q.query("select delete_workspace($1)", [ctx.workspaceId]);
  });
  deps.frames.evictWorkspace(ctx.workspaceId);
  try { await deps.storage.raw.deletePrefix(`w/${ctx.workspaceId}/`); } catch (e) { deps.log.error({ err: e, workspaceId: ctx.workspaceId }, "workspace files could not be purged; needs manual cleanup"); }
}

export async function listAudit(deps: Deps, ctx: WorkspaceCtx, o: { limit: number; before?: number }) {
  return inWorkspace(deps, ctx, async (q) => (await q.query<{ id: number; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; meta: Record<string, unknown>; created_at: Date; actor_name: string | null; actor_email: string | null }>(
    `select a.id, a.actor_id, a.action, a.target_type, a.target_id, a.meta, a.created_at, u.name actor_name, u.email actor_email
     from audit_logs a left join users u on u.id = a.actor_id
     where a.workspace_id = $1 and ($2::bigint is null or a.id < $2) order by a.id desc limit $3`, [ctx.workspaceId, o.before ?? null, Math.min(o.limit, 200)]))
    .rows.map((r) => ({ id: r.id, actor: r.actor_id ? { id: r.actor_id, name: r.actor_name, email: r.actor_email } : null, action: r.action, targetType: r.target_type, targetId: r.target_id, meta: r.meta, createdAt: r.created_at })));
}
