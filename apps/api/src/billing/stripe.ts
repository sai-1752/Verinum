/**
 * Stripe over plain fetch (no SDK): checkout, customer portal and signed-webhook parsing.
 * Webhook signatures are verified manually (HMAC-SHA256 over `${t}.${rawBody}`, constant-time
 * compare, 5-minute tolerance) against the raw request body.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, badRequest } from "../errors";
import type { BillingEvent, BillingProvider } from "./provider";

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  apiBase: string;
  /** plan id → Stripe price id */
  prices: Record<string, string>;
  fetch: typeof fetch;
}

const form = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)).toString();

export function signStripePayload(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

export class StripeProvider implements BillingProvider {
  readonly name = "stripe";
  constructor(private readonly o: StripeOptions) {}

  private async call<T>(path: string, body: Record<string, string | undefined>): Promise<T> {
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.apiBase.replace(/\/$/, "")}${path}`, {
        method: "POST", body: form(body), signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.o.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      });
    } catch { throw new AppError(502, "billing_unavailable", "The billing provider could not be reached. Try again shortly."); }
    if (!res.ok) throw new AppError(502, "billing_error", "The billing provider rejected the request.");
    return (await res.json()) as T;
  }

  async createCheckout(o: { workspaceId: string; planId: string; email: string; customerId?: string | null; successUrl: string; cancelUrl: string }): Promise<{ url: string }> {
    const price = this.o.prices[o.planId];
    if (!price) throw badRequest("That plan can't be purchased online.");
    const r = await this.call<{ url?: string }>("/v1/checkout/sessions", {
      mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": "1",
      success_url: o.successUrl, cancel_url: o.cancelUrl, client_reference_id: o.workspaceId,
      "metadata[workspace_id]": o.workspaceId, "metadata[plan_id]": o.planId,
      "subscription_data[metadata][workspace_id]": o.workspaceId, "subscription_data[metadata][plan_id]": o.planId,
      ...(o.customerId ? { customer: o.customerId } : { customer_email: o.email }),
    });
    if (!r.url) throw new AppError(502, "billing_error", "The billing provider returned no checkout link.");
    return { url: r.url };
  }

  async createPortal(o: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const r = await this.call<{ url?: string }>("/v1/billing_portal/sessions", { customer: o.customerId, return_url: o.returnUrl });
    if (!r.url) throw new AppError(502, "billing_error", "The billing provider returned no portal link.");
    return { url: r.url };
  }

  parseWebhook(rawBody: string, header: string | undefined, nowSeconds: number): BillingEvent {
    if (!header) throw new AppError(400, "bad_signature", "Missing signature.");
    const parts = header.split(",").map((p) => p.trim().split("="));
    const t = Number(parts.find(([k]) => k === "t")?.[1]);
    const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
    if (!Number.isFinite(t) || !sigs.length) throw new AppError(400, "bad_signature", "Malformed signature.");
    if (Math.abs(nowSeconds - t) > 300) throw new AppError(400, "bad_signature", "Signature timestamp outside tolerance.");
    const expected = createHmac("sha256", this.o.webhookSecret).update(`${t}.${rawBody}`).digest();
    const ok = sigs.some((s) => { const b = Buffer.from(s, "hex"); return b.length === expected.length && timingSafeEqual(b, expected); });
    if (!ok) throw new AppError(400, "bad_signature", "Signature mismatch.");

    let ev: { id: string; type: string; data: { object: Record<string, any> } };
    try { ev = JSON.parse(rawBody); } catch { throw new AppError(400, "bad_request", "Invalid payload."); }
    const obj = ev.data?.object ?? {};
    const planFromPrice = (priceId?: string) => Object.entries(this.o.prices).find(([, id]) => id === priceId)?.[0] ?? null;

    if (ev.type === "checkout.session.completed" && obj.mode === "subscription") {
      return { kind: "subscription", eventId: ev.id, workspaceId: obj.client_reference_id ?? obj.metadata?.workspace_id ?? null, customerId: String(obj.customer ?? ""), subscriptionId: String(obj.subscription ?? ""), planId: null, status: "linked", currentPeriodEnd: null, cancelAtPeriodEnd: false };
    }
    if (ev.type === "customer.subscription.created" || ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
      const item = obj.items?.data?.[0];
      return {
        kind: "subscription", eventId: ev.id, workspaceId: obj.metadata?.workspace_id ?? null, customerId: String(obj.customer ?? ""), subscriptionId: String(obj.id ?? ""),
        planId: obj.metadata?.plan_id ?? planFromPrice(item?.price?.id), status: ev.type === "customer.subscription.deleted" ? "canceled" : String(obj.status ?? ""),
        currentPeriodEnd: typeof (obj.current_period_end ?? item?.current_period_end) === "number" ? (obj.current_period_end ?? item?.current_period_end) : null,
        cancelAtPeriodEnd: !!obj.cancel_at_period_end,
      };
    }
    return { kind: "ignored", eventId: ev.id, type: ev.type };
  }
}
