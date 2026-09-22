import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { openPortal, startCheckout } from "../billing/service";
import type { Deps } from "../context";
import { permissionsFor, ROLES } from "../permissions";
import { usageSummary } from "../usage";
import { acceptInvitation, changeRole, deleteWorkspace, invite, listAudit, listInvitations, listMembers, previewInvitation, removeMember, renameWorkspace, revokeInvitation } from "../workspaces/members";
import { createWorkspace, inWorkspace, listMyWorkspaces, validateName } from "../workspaces/service";
import { getUser } from "../auth/service";
import { audit } from "../audit";
import { metaOf, parse, requireUser, workspaceFor } from "./util";

const Role = z.enum(ROLES as [string, ...string[]]);

export async function registerWorkspaceRoutes(app: FastifyInstance, deps: Deps) {
  const strict = { config: { rateLimit: { max: deps.config.RATE_LIMIT_AUTH_PER_MIN, timeWindow: "1 minute" } } };

  app.get("/workspaces", async (req) => ({ workspaces: await listMyWorkspaces(deps, requireUser(req).user.id) }));

  app.post("/workspaces", strict, async (req, reply) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ name: z.string() }).strict(), req.body);
    const ws = await createWorkspace(deps, user.id, validateName(body.name, "Workspace name")); // always the default plan; the plan is never client-supplied
    await audit(deps.db, { workspaceId: null, actorId: user.id, action: "workspace.create", targetType: "workspace", targetId: ws.id, ip: req.ip, requestId: req.id });
    return reply.status(201).send({ workspace: ws });
  });

  app.get("/workspaces/:workspaceId", async (req) => {
    const ctx = await workspaceFor(deps, req, "workspace.read");
    return { workspace: { ...ctx.workspace, role: ctx.role, permissions: permissionsFor(ctx.role), plan: { id: ctx.plan.id, name: ctx.plan.name, features: ctx.plan.features, limits: ctx.plan.limits } } };
  });

  app.patch("/workspaces/:workspaceId", async (req) => {
    const ctx = await workspaceFor(deps, req, "workspace.update");
    const body = parse(z.object({ name: z.string() }).strict(), req.body);
    await renameWorkspace(deps, ctx, validateName(body.name, "Workspace name"), metaOf(req));
    return { ok: true };
  });

  app.delete("/workspaces/:workspaceId", strict, async (req) => {
    const ctx = await workspaceFor(deps, req, "workspace.delete");
    const body = parse(z.object({ confirm: z.string() }).strict(), req.body);
    await deleteWorkspace(deps, ctx, body.confirm, metaOf(req));
    return { ok: true };
  });

  /* ---- members & invitations ---- */
  app.get("/workspaces/:workspaceId/members", async (req) => {
    const ctx = await workspaceFor(deps, req, "member.read");
    return { members: await listMembers(deps, ctx), invitations: ctx.role === "owner" || ctx.role === "admin" ? await listInvitations(deps, ctx) : [] };
  });

  app.post("/workspaces/:workspaceId/invitations", strict, async (req, reply) => {
    const ctx = await workspaceFor(deps, req, "member.invite");
    const body = parse(z.object({ email: z.string().trim().email().max(254), role: Role }).strict(), req.body);
    const me = await getUser(deps, ctx.userId);
    await invite(deps, ctx, { email: body.email, role: body.role as never }, me?.name ?? "", metaOf(req));
    return reply.status(201).send({ ok: true });
  });

  app.delete("/workspaces/:workspaceId/invitations/:id", async (req) => {
    const ctx = await workspaceFor(deps, req, "member.invite");
    await revokeInvitation(deps, ctx, (req.params as { id: string }).id, metaOf(req));
    return { ok: true };
  });

  app.patch("/workspaces/:workspaceId/members/:userId", async (req) => {
    const ctx = await workspaceFor(deps, req, "member.role");
    const body = parse(z.object({ role: Role }).strict(), req.body);
    await changeRole(deps, ctx, (req.params as { userId: string }).userId, body.role as never, metaOf(req));
    return { ok: true };
  });

  app.delete("/workspaces/:workspaceId/members/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    // any member may remove themselves; removing others needs member.remove
    const ctx = await workspaceFor(deps, req, userId === req.auth?.user.id ? "workspace.read" : "member.remove");
    await removeMember(deps, ctx, userId, metaOf(req));
    return { ok: true };
  });

  app.get("/invitations/preview", strict, async (req) => previewInvitation(deps, parse(z.object({ token: z.string().min(10).max(200) }), req.query).token));
  app.post("/invitations/accept", strict, async (req) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ token: z.string().min(10).max(200) }).strict(), req.body);
    return acceptInvitation(deps, user.id, body.token, metaOf(req));
  });

  /* ---- usage, audit, billing ---- */
  app.get("/workspaces/:workspaceId/usage", async (req) => usageSummary(deps, await workspaceFor(deps, req, "usage.read")));

  app.get("/workspaces/:workspaceId/audit", async (req) => {
    const ctx = await workspaceFor(deps, req, "audit.read");
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }), req.query);
    return { events: await listAudit(deps, ctx, q) };
  });

  app.get("/workspaces/:workspaceId/billing", async (req) => {
    const ctx = await workspaceFor(deps, req, "billing.read");
    const b = await inWorkspace(deps, ctx, async (q) => (await q.query<{ billing: Record<string, unknown> }>("select billing from workspaces where id = $1", [ctx.workspaceId])).rows[0]!.billing);
    return {
      enabled: !!deps.billing, plan: { id: ctx.plan.id, name: ctx.plan.name },
      subscription: b.subscriptionId ? { status: b.status, currentPeriodEnd: b.currentPeriodEnd, cancelAtPeriodEnd: b.cancelAtPeriodEnd } : null, hasCustomer: !!b.customerId,
    };
  });
  app.post("/workspaces/:workspaceId/billing/checkout", strict, async (req) => {
    const ctx = await workspaceFor(deps, req, "billing.manage");
    const body = parse(z.object({ plan: z.string().max(40) }).strict(), req.body);
    return startCheckout(deps, ctx, body.plan, requireUser(req).user.email);
  });
  app.post("/workspaces/:workspaceId/billing/portal", strict, async (req) => openPortal(deps, await workspaceFor(deps, req, "billing.manage")));
}
