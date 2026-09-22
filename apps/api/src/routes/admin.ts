import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../context";
import { badRequest, forbidden } from "../errors";
import { audit } from "../audit";
import { metaOf, parse, requireUser } from "./util";

/**
 * Platform administration. Metadata only: counts, plans, job states and the audit trail. There is no
 * endpoint that reads a workspace's datasets, rows or conversations. The database enforces the same
 * boundary: the admin_* functions return no tenant content, and check is_platform_admin themselves.
 */
export async function registerAdminRoutes(app: FastifyInstance, deps: Deps) {
  const admin = async (req: import("fastify").FastifyRequest) => {
    const { user } = requireUser(req);
    if (!user.isPlatformAdmin) throw forbidden("This area is for platform administrators.");
    return user;
  };
  const inAdmin = <T>(userId: string, fn: (q: import("../db").Q) => Promise<T>) => deps.db.tx({ userId }, fn);

  app.get("/admin/overview", async (req) => {
    const u = await admin(req);
    return inAdmin(u.id, async (q) => (await q.query<{ admin_overview: unknown }>("select admin_overview()")).rows[0]!.admin_overview);
  });

  app.get("/admin/workspaces", async (req) => {
    const u = await admin(req);
    const q = parse(z.object({ q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const rows = await inAdmin(u.id, async (c) => (await c.query("select * from admin_workspaces($1,$2,$3)", [q.q ?? null, q.limit, q.offset])).rows);
    return { workspaces: rows };
  });

  app.get("/admin/jobs", async (req) => {
    const u = await admin(req);
    const q = parse(z.object({ status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return { jobs: await inAdmin(u.id, async (c) => (await c.query("select * from admin_jobs($1,$2)", [q.status ?? null, q.limit])).rows) };
  });

  app.get("/admin/audit", async (req) => {
    const u = await admin(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return { events: await inAdmin(u.id, async (c) => (await c.query("select * from admin_audit($1)", [q.limit])).rows) };
  });

  app.post("/admin/workspaces/:workspaceId/plan", async (req) => {
    const u = await admin(req);
    const id = (req.params as { workspaceId: string }).workspaceId;
    const body = parse(z.object({ plan: z.string().max(40) }).strict(), req.body);
    if (!deps.plans.has(body.plan)) throw badRequest("Unknown plan.");
    await inAdmin(u.id, async (c) => {
      await c.query("select admin_set_workspace_plan($1,$2)", [id, body.plan]);
      await audit(c, { workspaceId: null, actorId: u.id, action: "admin.set_plan", targetType: "workspace", targetId: id, meta: { plan: body.plan }, ip: metaOf(req).ip, requestId: req.id });
    });
    return { ok: true };
  });
}
