/** Usage metering and plan checks. Usage is derived from durable rows, never from in-memory counters. */
import type { Deps } from "./context";
import type { Q } from "./db";
import type { Plan } from "./plans";
import { enforce, isUnlimited } from "./plans";
import { inWorkspace, type WorkspaceCtx } from "./workspaces/service";

export type UsageKind = "ai_message" | "export" | "dataset_processed";

/** The plan of a workspace, read inside its tenant scope (used by background jobs). */
export async function workspacePlan(deps: Deps, workspaceId: string, userId: string | null): Promise<Plan> {
  const r = await deps.db.tx({ userId, workspaceId }, async (q) => (await q.query<{ plan_id: string }>("select plan_id from workspaces where id = $1", [workspaceId])).rows[0]);
  return deps.plans.get(r?.plan_id ?? deps.plans.defaultId);
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export async function monthlyUsage(q: Q, kind: UsageKind, now: Date): Promise<number> {
  const r = await q.query<{ n: string | null }>("select coalesce(sum(quantity), 0) n from usage_events where kind = $1 and created_at >= $2", [kind, monthStart(now)]);
  return Number(r.rows[0]!.n ?? 0);
}

/** Checks the monthly allowance and records the event atomically (one advisory lock per workspace+kind). */
export async function consume(deps: Deps, ctx: WorkspaceCtx, kind: "ai_message" | "export", meta: Record<string, unknown> = {}): Promise<void> {
  const limit = kind === "ai_message" ? "aiMessagesPerMonth" : "exportsPerMonth";
  await inWorkspace(deps, ctx, async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`usage:${ctx.workspaceId}:${kind}`]);
    const used = await monthlyUsage(q, kind, deps.now());
    enforce(ctx.plan, limit, used, 1, kind === "ai_message" ? "AI messages per month" : "exports per month");
    await q.query("insert into usage_events (workspace_id, user_id, kind, quantity, meta) values ($1,$2,$3,1,$4)", [ctx.workspaceId, ctx.userId, kind, JSON.stringify(meta)]);
  });
}

export async function usageSummary(deps: Deps, ctx: WorkspaceCtx) {
  return inWorkspace(deps, ctx, async (q) => {
    const now = deps.now();
    const [ai, exp] = await Promise.all([monthlyUsage(q, "ai_message", now), monthlyUsage(q, "export", now)]);
    const c = (await q.query<{ datasets: number; bytes: string | null; members: number }>(
      `select (select count(*)::int from datasets where status <> 'deleting') datasets,
              (select coalesce(sum(byte_size),0) from dataset_versions v join datasets d on d.id = v.dataset_id where d.status <> 'deleting') bytes,
              (select count(*)::int from memberships where workspace_id = $1) members`, [ctx.workspaceId])).rows[0]!;
    const l = ctx.plan.limits;
    const row = (used: number, limit: number) => ({ used, limit: isUnlimited(limit) ? null : limit });
    return {
      plan: { id: ctx.plan.id, name: ctx.plan.name }, periodStart: monthStart(now).toISOString(),
      datasets: row(c.datasets, l.maxDatasets), storageBytes: row(Number(c.bytes ?? 0), l.storageBytes), members: row(c.members, l.maxMembers),
      aiMessages: row(ai, l.aiMessagesPerMonth), exports: row(exp, l.exportsPerMonth),
    };
  });
}

/** True while the workspace still has allowance for `kind` this month (read-only; nothing is recorded). */
export async function hasAllowance(deps: Deps, ctx: WorkspaceCtx, kind: "ai_message" | "export"): Promise<boolean> {
  const max = ctx.plan.limits[kind === "ai_message" ? "aiMessagesPerMonth" : "exportsPerMonth"];
  if (isUnlimited(max)) return true;
  const used = await inWorkspace(deps, ctx, (q) => monthlyUsage(q, kind, deps.now()));
  return used < max;
}

export async function record(deps: Deps, ctx: WorkspaceCtx, kind: UsageKind, meta: Record<string, unknown> = {}, quantity = 1): Promise<void> {
  await inWorkspace(deps, ctx, (q) => q.query("insert into usage_events (workspace_id, user_id, kind, quantity, meta) values ($1,$2,$3,$4,$5)", [ctx.workspaceId, ctx.userId, kind, quantity, JSON.stringify(meta)]));
}
