import { randomBytes } from "node:crypto";
import type { Deps } from "../context";
import type { Q } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { can, type Action, type Role } from "../permissions";
import type { Plan } from "../plans";

export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Creates a workspace owned by `userId` (atomic: workspace + owner membership). Retries slug collisions. */
export async function createWorkspace(deps: Deps, userId: string, name: string, planId = deps.plans.defaultId): Promise<{ id: string; slug: string }> {
  const base = slugify(name) || "workspace";
  for (let attempt = 0; attempt < 6; attempt++) {
    let slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    if (slug.length < 3) slug = `${slug}-ws`;
    try {
      const id = await deps.db.tx({ userId }, async (q) => (await q.query<{ create_workspace: string }>("select create_workspace($1,$2,$3)", [name, slug, planId])).rows[0]!.create_workspace);
      return { id, slug };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") continue;
      throw e;
    }
  }
  throw conflict("Couldn't pick a unique workspace address; try a different name.");
}

export interface WorkspaceCtx {
  userId: string;
  workspaceId: string;
  role: Role;
  plan: Plan;
  workspace: { id: string; name: string; slug: string; planId: string; settings: Record<string, unknown> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

/**
 * The ONLY way to obtain a workspace context. Verifies the caller's membership (a non-member gets
 * 404, so workspace ids can't be probed), then the role's permission for the action.
 */
export async function resolveWorkspace(deps: Deps, userId: string, workspaceId: string, action: Action): Promise<WorkspaceCtx> {
  if (!isUuid(workspaceId)) throw notFound("Workspace");
  const row = await deps.db.tx({ userId }, async (q) => (await q.query<{ role: Role; id: string; name: string; slug: string; plan_id: string; settings: Record<string, unknown> }>(
    `select m.role, w.id, w.name, w.slug, w.plan_id, w.settings from memberships m join workspaces w on w.id = m.workspace_id
     where m.workspace_id = $1 and m.user_id = $2 and w.deleted_at is null`, [workspaceId, userId])).rows[0]);
  if (!row) throw notFound("Workspace");
  if (!can(row.role, action)) throw forbidden();
  return { userId, workspaceId: row.id, role: row.role, plan: deps.plans.get(row.plan_id), workspace: { id: row.id, name: row.name, slug: row.slug, planId: row.plan_id, settings: row.settings ?? {} } };
}

/** Runs `fn` in a transaction scoped to the workspace (RLS applies). */
export function inWorkspace<T>(deps: Deps, ctx: Pick<WorkspaceCtx, "userId" | "workspaceId">, fn: (q: Q) => Promise<T>): Promise<T> {
  return deps.db.tx({ userId: ctx.userId, workspaceId: ctx.workspaceId }, fn);
}

export async function listMyWorkspaces(deps: Deps, userId: string) {
  const rows = await deps.db.tx({ userId }, async (q) => (await q.query<{ id: string; name: string; slug: string; plan_id: string; role: Role; created_at: Date }>(
    `select w.id, w.name, w.slug, w.plan_id, m.role, w.created_at from memberships m join workspaces w on w.id = m.workspace_id
     where m.user_id = $1 and w.deleted_at is null order by w.created_at`, [userId])).rows);
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, planId: r.plan_id, role: r.role, createdAt: r.created_at }));
}

export function validateName(name: unknown, what = "Name"): string {
  if (typeof name !== "string" || !name.trim()) throw badRequest(`${what} is required.`);
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length > 120) throw badRequest(`${what} is too long.`);
  return n;
}
