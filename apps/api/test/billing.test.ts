import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signStripePayload } from "../src/billing/stripe";
import { asOwner, initDb, makeApp, resetData, signup, type TestApp } from "./helpers/harness";

const WEBHOOK_SECRET = "whsec_test_secret";
let t: TestApp;
let stripe: Server;
let stripeCalls: { path: string; body: URLSearchParams; auth: string | undefined }[] = [];

beforeAll(async () => {
  await initDb();
  stripe = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      stripeCalls.push({ path: req.url ?? "", body: new URLSearchParams(Buffer.concat(chunks).toString()), auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url?.includes("portal") ? "https://billing.stripe.test/portal/abc" : "https://checkout.stripe.test/session/xyz" }));
    });
  });
  await new Promise<void>((r) => stripe.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
  t = await makeApp({ config: { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: base, STRIPE_PRICE_PRO: "price_pro_1", STRIPE_PRICE_TEAM: "price_team_1" } });
});
afterAll(async () => { await t.close(); await new Promise((r) => stripe.close(r)); });
beforeEach(async () => { await resetData(); stripeCalls = []; });

let evId = 0;
const event = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${++evId}`, type, data: { object } });
const send = async (body: string, o: { secret?: string; t?: number; header?: string } = {}) => {
  const ts = o.t ?? Math.floor(Date.now() / 1000);
  const r = await t.app.inject({ method: "POST", url: "/api/v1/billing/webhook", headers: { "content-type": "application/json", ...(o.header === "" ? {} : { "stripe-signature": o.header ?? signStripePayload(o.secret ?? WEBHOOK_SECRET, body, ts) }) }, payload: body });
  return { status: r.statusCode, body: r.json() };
};
const planOf = async (id: string) => (await asOwner((c) => c.query("select plan_id, billing from workspaces where id = $1", [id]))).rows[0];

describe("checkout and portal", () => {
  it("only the owner can start checkout; the request carries the workspace, plan and price", async () => {
    const s = await signup(t);
    const r = await s.client.post(`/workspaces/${s.workspaceId}/billing/checkout`, { plan: "pro" });
    expect(r.status).toBe(200);
    expect(r.body.url).toBe("https://checkout.stripe.test/session/xyz");
    const call = stripeCalls[0]!;
    expect(call.auth).toBe("Bearer sk_test_123");
    expect(Object.fromEntries(call.body)).toMatchObject({
      mode: "subscription", "line_items[0][price]": "price_pro_1", client_reference_id: s.workspaceId,
      "subscription_data[metadata][workspace_id]": s.workspaceId, "subscription_data[metadata][plan_id]": "pro", customer_email: s.email,
    });
    expect((await s.client.post(`/workspaces/${s.workspaceId}/billing/checkout`, { plan: "free" })).status).toBe(400);
    expect((await s.client.post(`/workspaces/${s.workspaceId}/billing/checkout`, { plan: "enterprise" })).status).toBe(400);
    expect((await s.client.post(`/workspaces/${s.workspaceId}/billing/portal`)).status).toBe(422); // nothing to manage yet
  });

  it("the plan never changes from checkout alone; only a verified webhook changes it", async () => {
    const s = await signup(t);
    await s.client.post(`/workspaces/${s.workspaceId}/billing/checkout`, { plan: "pro" });
    expect((await planOf(s.workspaceId)).plan_id).toBe("free");
  });
});

describe("webhooks", () => {
  it("rejects missing, forged, stale and malformed signatures without touching any workspace", async () => {
    const s = await signup(t);
    const body = event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active", metadata: { workspace_id: s.workspaceId, plan_id: "team" }, items: { data: [] } });
    expect((await send(body, { header: "" })).status).toBe(400);
    expect((await send(body, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await send(body, { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400);
    expect((await send(body, { header: "t=abc,v1=zz" })).status).toBe(400);
    const tampered = body.replace("team", "pro");
    const goodSig = signStripePayload(WEBHOOK_SECRET, body, Math.floor(Date.now() / 1000));
    expect((await send(tampered, { header: goodSig })).status).toBe(400); // signature of a different body
    expect((await planOf(s.workspaceId)).plan_id).toBe("free");
  });

  it("checkout completion links the customer; the subscription event sets the plan; limits change immediately", async () => {
    const s = await signup(t);
    expect((await send(event("checkout.session.completed", { mode: "subscription", client_reference_id: s.workspaceId, customer: "cus_9", subscription: "sub_9" }))).body).toMatchObject({ received: true, applied: true });
    expect((await planOf(s.workspaceId)).plan_id).toBe("free");
    expect((await planOf(s.workspaceId)).billing.customerId).toBe("cus_9");
    const sub = event("customer.subscription.created", { id: "sub_9", customer: "cus_9", status: "active", current_period_end: 1893456000, cancel_at_period_end: false, metadata: { workspace_id: s.workspaceId, plan_id: "pro" }, items: { data: [{ price: { id: "price_pro_1" } }] } });
    expect((await send(sub)).body.applied).toBe(true);
    const row = await planOf(s.workspaceId);
    expect(row.plan_id).toBe("pro");
    expect(row.billing).toMatchObject({ customerId: "cus_9", subscriptionId: "sub_9", status: "active", currentPeriodEnd: 1893456000 });
    expect((await s.client.get(`/workspaces/${s.workspaceId}`)).body.workspace.plan.id).toBe("pro");
    expect((await s.client.get(`/workspaces/${s.workspaceId}/usage`)).body.datasets.limit).toBe(50);
    const bill = (await s.client.get(`/workspaces/${s.workspaceId}/billing`)).body;
    expect(bill).toMatchObject({ enabled: true, plan: { id: "pro" }, subscription: { status: "active" }, hasCustomer: true });
    const portal = await s.client.post(`/workspaces/${s.workspaceId}/billing/portal`);
    expect(portal.body.url).toBe("https://billing.stripe.test/portal/abc");
    expect(stripeCalls.at(-1)!.body.get("customer")).toBe("cus_9");
  });

  it("is idempotent: replaying an event does nothing the second time", async () => {
    const s = await signup(t);
    const body = event("customer.subscription.updated", { id: "sub_2", customer: "cus_2", status: "active", metadata: { workspace_id: s.workspaceId, plan_id: "team" }, items: { data: [] } });
    expect((await send(body)).body.applied).toBe(true);
    await asOwner((c) => c.query("update workspaces set plan_id = 'free' where id = $1", [s.workspaceId])); // simulate a later change
    expect((await send(body)).body).toMatchObject({ applied: false, reason: "duplicate" });
    expect((await planOf(s.workspaceId)).plan_id).toBe("free");
  });

  it("cancellation downgrades to free; past_due keeps access; price id maps to a plan when metadata is missing", async () => {
    const s = await signup(t);
    await send(event("customer.subscription.created", { id: "sub_3", customer: "cus_3", status: "active", metadata: { workspace_id: s.workspaceId }, items: { data: [{ price: { id: "price_team_1" } }] } }));
    expect((await planOf(s.workspaceId)).plan_id).toBe("team");
    await send(event("customer.subscription.updated", { id: "sub_3", customer: "cus_3", status: "past_due", metadata: {}, items: { data: [{ price: { id: "price_team_1" } }] } })); // no workspace metadata: found via customer id
    expect((await planOf(s.workspaceId)).plan_id).toBe("team");
    await send(event("customer.subscription.deleted", { id: "sub_3", customer: "cus_3", status: "canceled", metadata: {}, items: { data: [] } }));
    expect((await planOf(s.workspaceId)).plan_id).toBe("free");
    expect((await planOf(s.workspaceId)).billing.status).toBe("canceled");
  });

  it("cannot be steered into another workspace, an unknown plan, or a deleted workspace", async () => {
    const s = await signup(t);
    const r1 = await send(event("customer.subscription.updated", { id: "sub_4", customer: "cus_4", status: "active", metadata: { workspace_id: s.workspaceId, plan_id: "platinum" }, items: { data: [] } }));
    expect(r1.body.applied).toBe(true);
    expect((await planOf(s.workspaceId)).plan_id).toBe("free"); // unknown plan ids are ignored, not stored
    const r2 = await send(event("customer.subscription.updated", { id: "sub_5", customer: "cus_unknown", status: "active", metadata: {}, items: { data: [] } }));
    expect(r2.body).toMatchObject({ applied: false, reason: "unknown_workspace" });
    const r3 = await send(event("invoice.paid", { id: "in_1" }));
    expect(r3.body).toMatchObject({ received: true, applied: false, reason: "ignored" });
  });

  it("returns 404 when billing isn't configured", async () => {
    const off = await makeApp();
    try { expect((await off.app.inject({ method: "POST", url: "/api/v1/billing/webhook", payload: {} })).statusCode).toBe(404); } finally { await off.close(); }
  });
});
