import { audit } from "../audit";
import type { Deps } from "../context";
import { AppError, badRequest, unprocessable } from "../errors";
import { PlanCatalog } from "../plans";
import type { Config } from "../config";
import { StripeProvider } from "./stripe";
import type { BillingEvent, BillingProvider } from "./provider";
import { inWorkspace, type WorkspaceCtx } from "../workspaces/service";

export function createBilling(cfg: Config, plans: PlanCatalog, fetchFn: typeof fetch): BillingProvider | null {
  if (cfg.BILLING_PROVIDER !== "stripe" || !cfg.STRIPE_SECRET_KEY || !cfg.STRIPE_WEBHOOK_SECRET) return null;
  const prices: Record<string, string> = {};
  for (const p of plans.all()) {
    const price = p.stripePriceEnv ? (cfg as unknown as Record<string, string | undefined>)[p.stripePriceEnv] : undefined;
    if (price) prices[p.id] = price;
  }
  return new StripeProvider({ secretKey: cfg.STRIPE_SECRET_KEY, webhookSecret: cfg.STRIPE_WEBHOOK_SECRET, apiBase: cfg.STRIPE_API_BASE, prices, fetch: fetchFn });
}

/** Subscription states in which the paid plan stays active. `past_due` keeps access while the provider retries payment. */
const ACTIVE = new Set(["active", "trialing", "past_due"]);

export async function applyBillingEvent(deps: Deps, ev: BillingEvent): Promise<{ applied: boolean; reason?: string }> {
  if (ev.kind === "ignored") return { applied: false, reason: "ignored" };
  const isNew = (await deps.db.query<{ billing_record_event: boolean }>("select billing_record_event($1,$2,$3)", [ev.eventId, deps.billing?.name ?? "billing", "subscription"])).rows[0]!.billing_record_event;
  if (!isNew) return { applied: false, reason: "duplicate" };

  let workspaceId = ev.workspaceId;
  if (!workspaceId && ev.customerId) {
    workspaceId = (await deps.db.query<{ billing_workspace_for_customer: string | null }>("select billing_workspace_for_customer($1)", [ev.customerId])).rows[0]!.billing_workspace_for_customer;
  }
  if (!workspaceId) { deps.log.warn({ eventId: ev.eventId }, "billing event for unknown workspace"); return { applied: false, reason: "unknown_workspace" }; }

  let plan: string | null = null;
  if (ev.status === "linked") plan = null;
  else if (ACTIVE.has(ev.status)) plan = ev.planId && deps.plans.has(ev.planId) ? ev.planId : null;
  else plan = deps.plans.defaultId; // canceled, unpaid, incomplete_expired…
  const billing = { customerId: ev.customerId || undefined, subscriptionId: ev.subscriptionId || undefined, status: ev.status, currentPeriodEnd: ev.currentPeriodEnd, cancelAtPeriodEnd: ev.cancelAtPeriodEnd };
  const ok = (await deps.db.query<{ billing_apply: boolean }>("select billing_apply($1,$2,$3)", [workspaceId, plan, JSON.stringify(billing)])).rows[0]!.billing_apply;
  await audit(deps.db, { workspaceId: null, action: "billing.event", targetType: "workspace", targetId: workspaceId, meta: { status: ev.status, plan } });
  deps.metrics.inc("billing_events_total", { status: ev.status });
  return { applied: ok };
}

export async function startCheckout(deps: Deps, ctx: WorkspaceCtx, planId: string, email: string): Promise<{ url: string }> {
  if (!deps.billing) throw new AppError(501, "billing_disabled", "Online billing isn't enabled on this deployment.");
  const target = deps.plans.has(planId) ? deps.plans.get(planId) : null;
  if (!target || target.id === deps.plans.defaultId) throw badRequest("Choose a paid plan.");
  if (ctx.workspace.planId === target.id) throw unprocessable("You're already on this plan.", "already_on_plan");
  const customerId = await inWorkspace(deps, ctx, async (q) => (await q.query<{ c: string | null }>("select billing ->> 'customerId' c from workspaces where id = $1", [ctx.workspaceId])).rows[0]?.c ?? null);
  const web = deps.config.PUBLIC_WEB_URL;
  return deps.billing.createCheckout({ workspaceId: ctx.workspaceId, planId: target.id, email, customerId, successUrl: `${web}/w/${ctx.workspaceId}/billing?checkout=success`, cancelUrl: `${web}/w/${ctx.workspaceId}/billing?checkout=cancelled` });
}

export async function openPortal(deps: Deps, ctx: WorkspaceCtx): Promise<{ url: string }> {
  if (!deps.billing) throw new AppError(501, "billing_disabled", "Online billing isn't enabled on this deployment.");
  const customerId = await inWorkspace(deps, ctx, async (q) => (await q.query<{ c: string | null }>("select billing ->> 'customerId' c from workspaces where id = $1", [ctx.workspaceId])).rows[0]?.c ?? null);
  if (!customerId) throw unprocessable("There's no subscription to manage yet.", "no_subscription");
  return deps.billing.createPortal({ customerId, returnUrl: `${deps.config.PUBLIC_WEB_URL}/w/${ctx.workspaceId}/billing` });
}
