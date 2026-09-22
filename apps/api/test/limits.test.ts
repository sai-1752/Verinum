import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlanCatalog } from "../src/plans";
import { asOwner, Client, demoDataset, drain, initDb, makeApp, resetData, signup, uniqueEmail, PASSWORD, type TestApp } from "./helpers/harness";

let t: TestApp;
beforeAll(async () => { await initDb(); t = await makeApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetData(); });

const ws = (s: { workspaceId: string }, p = "") => `/workspaces/${s.workspaceId}${p}`;
const csv = (n: number) => `Date,Sales\n${Array.from({ length: n }, (_, i) => `2025-01-${String((i % 28) + 1).padStart(2, "0")},${i + 1}`).join("\n")}\n`;

describe("plan limits (config-driven)", () => {
  it("free plan: dataset count limit returns 402 plan_limit with details, and an upgrade lifts it", async () => {
    const s = await signup(t);
    for (let i = 0; i < 3; i++) expect((await s.client.upload(ws(s, "/datasets"), `d${i}.csv`, csv(5))).status).toBe(202);
    const r = await s.client.upload(ws(s, "/datasets"), "d4.csv", csv(5));
    expect(r.status).toBe(402);
    expect(r.body.error).toMatchObject({ code: "plan_limit", details: { limit: "maxDatasets", max: 3, used: 3, plan: "free" } });
    expect(r.body.error.message).toMatch(/Upgrade/);
    await asOwner((c) => c.query("update workspaces set plan_id = 'pro' where id = $1", [s.workspaceId]));
    expect((await s.client.upload(ws(s, "/datasets"), "d4.csv", csv(5))).status).toBe(202);
  });

  it("a rejected upload leaves nothing behind (no rows, no stored file, no job)", async () => {
    const s = await signup(t);
    for (let i = 0; i < 3; i++) await s.client.upload(ws(s, "/datasets"), `d${i}.csv`, csv(5));
    await s.client.upload(ws(s, "/datasets"), "over.csv", csv(5));
    const n = await asOwner((c) => c.query("select (select count(*) from datasets)::int d, (select count(*) from jobs)::int j"));
    expect(n.rows[0]).toEqual({ d: 3, j: 3 });
  });

  it("concurrent uploads at the limit can't both slip through", async () => {
    const s = await signup(t);
    for (let i = 0; i < 2; i++) await s.client.upload(ws(s, "/datasets"), `d${i}.csv`, csv(5));
    const results = await Promise.all([0, 1, 2, 3].map((i) => s.client.upload(ws(s, "/datasets"), `race${i}.csv`, csv(5))));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
  });

  it("file size: oversized uploads are refused from the Content-Length header alone", async () => {
    const s = await signup(t);
    const r = await s.client.upload(ws(s, "/datasets"), "big.csv", Buffer.alloc(11 * 1024 * 1024, "a"));
    expect(r.status).toBe(402);
    expect(r.body.error.details).toMatchObject({ limit: "maxUploadBytes", plan: "free" });
  });

  it("row limit: a file with more rows than the plan allows fails processing with a plain-language reason", async () => {
    const custom = await makeApp({ deps: { plans: new PlanCatalog({
      free: { name: "Free", priceMonthlyUsd: 0, limits: { maxDatasets: 3, maxUploadBytes: 10485760, maxRowsPerDataset: 50, maxMembers: 3, aiMessagesPerMonth: 30, exportsPerMonth: 10, storageBytes: 104857600 }, features: { forecast: true, cohort: false, export: true, aiChat: true, rowExamples: false } },
    }) } });
    try {
      const c = new Client(custom);
      const reg = await c.post("/auth/register", { email: uniqueEmail(), password: PASSWORD, name: "Row Limit" });
      const up = await c.upload(`/workspaces/${reg.body.workspaceId}/datasets`, "many.csv", csv(200));
      expect(up.status).toBe(202);
      await drain(custom);
      const d = (await c.get(`/workspaces/${reg.body.workspaceId}/datasets/${up.body.datasetId}`)).body;
      expect(d.status).toBe("failed");
      expect(d.error).toMatch(/allows 50 rows/);
      const ok = await c.upload(`/workspaces/${reg.body.workspaceId}/datasets`, "few.csv", csv(40));
      await drain(custom);
      expect((await c.get(`/workspaces/${reg.body.workspaceId}/datasets/${ok.body.datasetId}`)).body.status).toBe("ready");
    } finally { await custom.close(); }
  });

  it("exports: monthly allowance is enforced and reported in /usage", async () => {
    const s = await signup(t);
    const { id } = await demoDataset(t, s);
    await asOwner((c) => c.query("insert into usage_events (workspace_id, kind, quantity) values ($1, 'export', 9)", [s.workspaceId]));
    expect((await s.client.post(ws(s, `/datasets/${id}/export`), { format: "csv" })).status).toBe(200);
    const r = await s.client.post(ws(s, `/datasets/${id}/export`), { format: "csv" });
    expect(r.status).toBe(402);
    expect(r.body.error.details.limit).toBe("exportsPerMonth");
    const u = (await s.client.get(ws(s, "/usage"))).body;
    expect(u).toMatchObject({ plan: { id: "free" }, datasets: { used: 1, limit: 3 }, exports: { used: 10, limit: 10 }, aiMessages: { used: 0, limit: 30 }, members: { used: 1, limit: 3 } });
    // usage from last month doesn't count
    await asOwner((c) => c.query("update usage_events set created_at = now() - interval '40 days'"));
    expect((await s.client.get(ws(s, "/usage"))).body.exports.used).toBe(0);
  });

  it("member limit counts pending invitations", async () => {
    const s = await signup(t);
    expect((await s.client.post(ws(s, "/invitations"), { email: uniqueEmail(), role: "viewer" })).status).toBe(201);
    expect((await s.client.post(ws(s, "/invitations"), { email: uniqueEmail(), role: "viewer" })).status).toBe(201);
    const third = await s.client.post(ws(s, "/invitations"), { email: uniqueEmail(), role: "viewer" });
    expect(third.status).toBe(402);
    expect(third.body.error.details.limit).toBe("maxMembers");
  });

  it("unlimited (-1) limits never block; plans are reported by /auth/config for the pricing page", async () => {
    const cfg = (await new Client(t).get("/auth/config")).body;
    expect(cfg.plans.map((p: any) => p.id)).toEqual(["free", "pro", "team"]);
    expect(cfg.plans.find((p: any) => p.id === "pro").limits.exportsPerMonth).toBe(-1);
    const s = await signup(t);
    await asOwner((c) => c.query("update workspaces set plan_id = 'pro' where id = $1", [s.workspaceId]));
    const { id } = await demoDataset(t, s);
    for (let i = 0; i < 12; i++) expect((await s.client.post(ws(s, `/datasets/${id}/export`), { format: "csv" })).status).toBe(200);
  });
});

describe("operational safeguards", () => {
  it("registration can be closed; email verification can be required", async () => {
    const closed = await makeApp({ config: { ALLOW_REGISTRATION: "false" } });
    try { expect((await new Client(closed).post("/auth/register", { email: uniqueEmail(), password: PASSWORD, name: "X" })).status).toBe(403); } finally { await closed.close(); }
    const strict = await makeApp({ config: { REQUIRE_EMAIL_VERIFICATION: "true" } });
    try {
      const c = new Client(strict);
      const reg = await c.post("/auth/register", { email: uniqueEmail(), password: PASSWORD, name: "X" });
      const r = await c.get(`/workspaces/${reg.body.workspaceId}/datasets`);
      expect(r.status).toBe(403);
      expect(r.body.error.message).toMatch(/Verify your email/);
      expect((await c.get("/auth/me")).status).toBe(200);
    } finally { await strict.close(); }
  });

  it("health endpoints, metrics and request ids", async () => {
    expect((await t.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const ready = await t.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.json()).toMatchObject({ ok: true, checks: { database: true } });
    const m = await t.app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toMatch(/http_requests_total/);
    const r = await new Client(t).get("/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.requestId).toBe(r.headers["x-request-id"]);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("internal errors never leak details", async () => {
    const s = await signup(t);
    await asOwner((c) => c.query("drop table dashboards cascade")); // sabotage: make a route fail unexpectedly
    const { id } = await demoDataset(t, s);
    const r = await s.client.get(ws(s, `/datasets/${id}/dashboards`));
    expect(r.status).toBe(500);
    expect(r.body.error).toMatchObject({ code: "internal", message: expect.stringMatching(/Something went wrong/) });
    expect(r.raw).not.toMatch(/dashboards|relation|postgres|select/i);
  });

  it("the metrics endpoint requires a token when one is configured", async () => {
    const m = await makeApp({ config: { METRICS_TOKEN: "s3cret-metrics-token" } });
    try {
      expect((await m.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(403);
      expect((await m.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(403);
      expect((await m.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer s3cret-metrics-token" } })).statusCode).toBe(200);
    } finally { await m.close(); }
  });
});
