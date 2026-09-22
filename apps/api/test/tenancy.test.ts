/**
 * Cross-tenant isolation. Two independent tenants (A, B), each with data. Every route that takes a
 * workspace or dataset id is probed from the other side, and the database is probed directly as the
 * restricted runtime role to prove row-level security holds even if the API layer were bypassed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asApp, asOwner, Client, demoDataset, initDb, makeApp, resetData, signup, type Session, type TestApp } from "./helpers/harness";
import { ScopedStore } from "../src/storage";

let t: TestApp;
let A: Session, B: Session;
let aDataset: string, bDataset: string, aVersion: string, aDashboard: string, aConversation: string, aMessage: string;

beforeAll(async () => {
  await initDb(); await resetData();
  t = await makeApp();
  A = await signup(t, "Alice", "alice@tenant-a.example");
  B = await signup(t, "Bob", "bob@tenant-b.example");
  aDataset = (await demoDataset(t, A)).id;
  bDataset = (await demoDataset(t, B)).id;
  const info = (await A.client.get(`/workspaces/${A.workspaceId}/datasets/${aDataset}`)).body;
  aVersion = info.currentVersionId;
  aDashboard = (await A.client.post(`/workspaces/${A.workspaceId}/datasets/${aDataset}/dashboards`, { name: "secret", widgets: [{ id: "w", title: "t", tool: "top_n", params: { dimension: "Product" }, size: "md" }] })).body.id;
  const chat = await A.client.post(`/workspaces/${A.workspaceId}/datasets/${aDataset}/chat`, { message: "What are the top 5 products?" });
  aConversation = chat.body.conversationId;
  aMessage = chat.body.messageId;
  expect(aConversation && aMessage).toBeTruthy();
});
afterAll(async () => { await t.close(); });

const wsA = (p = "") => `/workspaces/${A.workspaceId}${p}`;
const dsA = (p = "") => wsA(`/datasets/${aDataset}${p}`);

describe("HTTP: a signed-in user of another tenant sees nothing of tenant A", () => {
  const probes: [string, string, (() => unknown)?][] = [
    ["GET", "", undefined],
    ["GET", "/datasets"], ["GET", "/members"], ["GET", "/usage"], ["GET", "/audit"], ["GET", "/billing"],
    ["GET", "/datasets/DS"], ["GET", "/datasets/DS/profile"], ["GET", "/datasets/DS/quality"], ["GET", "/datasets/DS/insights"],
    ["GET", "/datasets/DS/columns"], ["GET", "/datasets/DS/tools"], ["GET", "/datasets/DS/versions"], ["GET", "/datasets/DS/dashboards"],
    ["GET", "/datasets/DS/conversations"], ["GET", "/datasets/DS/starter-questions"],
    ["POST", "/datasets/DS/rows"], ["POST", "/datasets/DS/dashboard"], ["POST", "/datasets/DS/tools/run"], ["POST", "/datasets/DS/export"], ["POST", "/datasets/DS/chat"],
    ["POST", "/datasets/DS/reprocess"], ["DELETE", "/datasets/DS"], ["PATCH", "/datasets/DS"],
  ];
  for (const [method, path] of probes) {
    it(`${method} /workspaces/A${path} → 404 for a non-member`, async () => {
      const url = wsA(path.replace("DS", aDataset));
      const body = method === "GET" || method === "DELETE" ? undefined : { message: "hi", tool: "top_n", params: { dimension: "Product" }, name: "x", options: {} };
      const r = method === "GET" ? await B.client.get(url) : method === "DELETE" ? await B.client.delete(url) : method === "PATCH" ? await B.client.patch(url, body) : await B.client.post(url, body);
      expect(r.status, `${method} ${url}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/Alice|tenant-a|Aura Watch|506/);
    });
  }

  it("the workspace's dataset still exists and is unchanged after all those attempts", async () => {
    const d = (await A.client.get(dsA())).body;
    expect(d.status).toBe("ready");
    expect(d.version.rowCount).toBe(6764);
  });

  it("using MY workspace id with THEIR dataset id finds nothing (ids are not global capabilities)", async () => {
    const urls = [`/datasets/${aDataset}`, `/datasets/${aDataset}/profile`, `/datasets/${aDataset}/insights`, `/datasets/${aDataset}/columns`, `/datasets/${aDataset}/versions`];
    for (const u of urls) expect((await B.client.get(`/workspaces/${B.workspaceId}${u}`)).status, u).toBe(404);
    expect((await B.client.post(`/workspaces/${B.workspaceId}/datasets/${aDataset}/rows`, {})).status).toBe(404);
    expect((await B.client.post(`/workspaces/${B.workspaceId}/datasets/${aDataset}/tools/run`, { tool: "top_n", params: { dimension: "Product" } })).status).toBe(404);
    expect((await B.client.post(`/workspaces/${B.workspaceId}/datasets/${aDataset}/chat`, { message: "top products" })).status).toBe(404);
    expect((await B.client.delete(`/workspaces/${B.workspaceId}/datasets/${aDataset}`)).status).toBe(404);
  });

  it("cannot activate, render, read or delete A's sub-resources through B's own dataset", async () => {
    const base = `/workspaces/${B.workspaceId}/datasets/${bDataset}`;
    expect((await B.client.post(`${base}/versions/${aVersion}/activate`)).status).toBe(404);
    expect((await B.client.post(`${base}/dashboard`, { dashboardId: aDashboard })).status).toBe(404);
    expect((await B.client.put(`${base}/dashboards/${aDashboard}`, { name: "x", widgets: [{ id: "w", title: "t", tool: "top_n", params: {}, size: "md" }] })).status).toBe(404);
    expect((await B.client.delete(`${base}/dashboards/${aDashboard}`)).status).toBe(404);
    expect((await B.client.get(`${base}/conversations/${aConversation}`)).status).toBe(404);
    expect((await B.client.delete(`${base}/conversations/${aConversation}`)).status).toBe(404);
    expect((await B.client.post(`${base}/chat`, { message: "hi", conversationId: aConversation })).status).toBe(404);
    expect((await B.client.post(`/workspaces/${B.workspaceId}/messages/${aMessage}/feedback`, { value: 1 })).status).toBe(404);
    expect((await A.client.get(dsA(`/dashboards`))).body.dashboards).toHaveLength(1); // untouched
  });

  it("cannot see or cancel A's jobs, or A's members and invitations", async () => {
    const jobId = (await asOwner((c) => c.query("select id from jobs where workspace_id = $1 limit 1", [A.workspaceId]))).rows[0].id;
    expect((await B.client.get(`/workspaces/${B.workspaceId}/jobs/${jobId}`)).status).toBe(404);
    expect((await B.client.post(`/workspaces/${B.workspaceId}/jobs/${jobId}/cancel`)).body.cancelled).toBe(false);
    expect((await B.client.delete(`/workspaces/${A.workspaceId}/members/${A.userId}`)).status).toBe(404);
    expect((await B.client.post(`/workspaces/${A.workspaceId}/invitations`, { email: "x@example.com", role: "viewer" })).status).toBe(404);
  });

  it("cannot delete, rename or upgrade another tenant's workspace", async () => {
    expect((await B.client.delete(`/workspaces/${A.workspaceId}`, { confirm: "Alice's workspace" })).status).toBe(404);
    expect((await B.client.patch(`/workspaces/${A.workspaceId}`, { name: "pwned" })).status).toBe(404);
    expect((await B.client.post(`/workspaces/${A.workspaceId}/billing/checkout`, { plan: "pro" })).status).toBe(404);
    expect((await A.client.get(wsA())).body.workspace.name).toBe("Alice's workspace");
  });

  it("malformed and guessed ids are handled uniformly (404, no SQL errors leaked)", async () => {
    for (const id of ["not-a-uuid", "00000000-0000-0000-0000-000000000000", "1; drop table datasets", "%00"]) {
      const r = await B.client.get(`/workspaces/${id}/datasets`);
      expect(r.status).toBe(404);
      expect(r.raw).not.toMatch(/syntax|postgres|relation|invalid input/i);
    }
  });

  it("listings only ever contain the caller's own tenant", async () => {
    const mine = (await B.client.get(`/workspaces/${B.workspaceId}/datasets`)).body.datasets;
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(bDataset);
    const me = (await B.client.get("/auth/me")).body;
    expect(me.workspaces.map((w: any) => w.id)).toEqual([B.workspaceId]);
  });
});

describe("Database: row-level security holds even if the API layer is bypassed", () => {
  const withCtx = async <T>(ws: string | null, user: string | null, fn: (c: import("pg").Client) => Promise<T>) =>
    asApp(async (c) => {
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)", [ws ?? "", user ?? ""]);
      try { return await fn(c); } finally { await c.query("rollback"); }
    });

  const TENANT_TABLES = ["datasets", "dataset_versions", "dashboards", "conversations", "messages", "usage_events", "jobs"];

  it("with no tenant context, every tenant table is empty (fails closed)", async () => {
    await withCtx(null, null, async (c) => {
      for (const t2 of TENANT_TABLES) expect((await c.query(`select count(*)::int n from ${t2}`)).rows[0].n, t2).toBe(0);
      expect((await c.query("select count(*)::int n from memberships")).rows[0].n).toBe(0);
      expect((await c.query("select count(*)::int n from workspaces")).rows[0].n).toBe(0);
      expect((await c.query("select count(*)::int n from invitations")).rows[0].n).toBe(0);
    });
  });

  it("with tenant B's context, only B's rows are visible in every tenant table", async () => {
    await withCtx(B.workspaceId, B.userId, async (c) => {
      for (const t2 of TENANT_TABLES) {
        const r = await c.query(`select distinct workspace_id from ${t2}`);
        expect(r.rows.every((x) => x.workspace_id === B.workspaceId), t2).toBe(true);
      }
      expect((await c.query("select count(*)::int n from datasets")).rows[0].n).toBe(1);
      expect((await c.query("select id from workspaces")).rows.map((r) => r.id)).toEqual([B.workspaceId]);
      // A's row, addressed by primary key, is invisible
      expect((await c.query("select 1 from datasets where id = $1", [aDataset])).rowCount).toBe(0);
      expect((await c.query("select 1 from dataset_versions where id = $1", [aVersion])).rowCount).toBe(0);
    });
  });

  it("B's context cannot update or delete A's rows (they don't exist for B)", async () => {
    await withCtx(B.workspaceId, B.userId, async (c) => {
      expect((await c.query("update datasets set name = 'pwned' where id = $1", [aDataset])).rowCount).toBe(0);
      expect((await c.query("delete from datasets where id = $1", [aDataset])).rowCount).toBe(0);
      expect((await c.query("delete from dataset_versions where workspace_id = $1", [A.workspaceId])).rowCount).toBe(0);
      expect((await c.query("delete from messages")).rowCount).toBe(0); // B has no messages; A's are untouched
    });
    expect((await asOwner((c) => c.query("select name from datasets where id = $1", [aDataset]))).rows[0].name).toMatch(/Demo/);
  });

  it("B's context cannot INSERT rows into A's workspace", async () => {
    for (const sql of [
      "insert into datasets (workspace_id, name) values ($1, 'planted')",
      "insert into usage_events (workspace_id, kind) values ($1, 'ai_message')",
      "insert into jobs (workspace_id, kind) values ($1, 'dataset.process')",
      "insert into dashboards (workspace_id, dataset_id, widgets) values ($1, gen_random_uuid(), '[]')",
    ]) {
      await expect(withCtx(B.workspaceId, B.userId, (c) => c.query(sql, [A.workspaceId])), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("composite foreign keys stop a row in B's workspace from pointing at A's dataset", async () => {
    await expect(withCtx(B.workspaceId, B.userId, (c) => c.query(
      "insert into dataset_versions (workspace_id, dataset_id, version, storage_original) values ($1, $2, 99, 'x')", [B.workspaceId, aDataset]))).rejects.toMatchObject({ code: "23503" });
    await expect(withCtx(B.workspaceId, B.userId, (c) => c.query(
      "insert into conversations (workspace_id, dataset_id, user_id) values ($1, $2, $3)", [B.workspaceId, aDataset, B.userId]))).rejects.toMatchObject({ code: "23503" });
  });

  it("B cannot join A's workspace by inserting a membership, or read A's members", async () => {
    await expect(withCtx(B.workspaceId, B.userId, (c) => c.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [A.workspaceId, B.userId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withCtx(A.workspaceId, B.userId, (c) => c.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [A.workspaceId, B.userId]))).rejects.toMatchObject({ code: "42501" }); // even claiming A's context: not an owner/admin there
    expect((await withCtx(B.workspaceId, B.userId, (c) => c.query("select * from memberships where workspace_id = $1", [A.workspaceId]))).rowCount).toBe(0);
  });

  it("the runtime role cannot bypass RLS, alter the schema, or read migrations", async () => {
    await asApp(async (c) => {
      const me = (await c.query("select rolsuper, rolbypassrls, (select count(*) from pg_class where relowner = (select oid from pg_roles where rolname = current_user)) owned from pg_roles where rolname = current_user")).rows[0];
      expect(me).toMatchObject({ rolsuper: false, rolbypassrls: false });
      expect(Number(me.owned)).toBe(0); // owns nothing, so it can never disable RLS on a table
      await expect(c.query("alter table datasets disable row level security")).rejects.toMatchObject({ code: "42501" });
      await expect(c.query("create table pwn (x int)")).rejects.toMatchObject({ code: "42501" });
      await expect(c.query("select * from schema_migrations")).rejects.toMatchObject({ code: "42501" });
      await expect(c.query("truncate datasets")).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("every tenant table has RLS enabled (guards against a future migration forgetting)", async () => {
    const rows = (await asOwner((c) => c.query(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped)`))).rows;
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const r of rows) expect(r.relrowsecurity, `RLS on ${r.relname}`).toBe(true);
  });

  it("the cross-tenant surface is exactly the documented SECURITY DEFINER functions, each with a pinned search_path", async () => {
    const rows = (await asOwner((c) => c.query(
      `select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef order by p.proname`))).rows;
    expect(rows.map((r) => r.proname)).toEqual([
      "accept_invitation", "admin_audit", "admin_jobs", "admin_overview", "admin_set_workspace_plan", "admin_workspaces",
      "app_can_manage", "app_role_in", "assert_platform_admin",
      "billing_apply", "billing_record_event", "billing_workspace_for_customer", "create_workspace", "delete_workspace",
      "invitation_preview", "job_cancel", "job_claim", "job_fail", "job_finish", "job_heartbeat", "job_reap",
    ]); // adding one means updating this list AND docs/SECURITY.md, on purpose
    for (const r of rows) expect((r.proconfig ?? []).join(","), `search_path of ${r.proname}`).toMatch(/search_path=public, pg_temp/);
  });
});

describe("Role escalation is refused by the database itself", () => {
  const withCtx = async <T>(ws: string, user: string, fn: (c: import("pg").Client) => Promise<T>) =>
    asApp(async (c) => {
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)", [ws, user]);
      try { return await fn(c); } finally { await c.query("rollback"); }
    });

  it("nobody can change a workspace's plan or billing through SQL as the app role", async () => {
    await expect(withCtx(A.workspaceId, A.userId, (c) => c.query("update workspaces set plan_id = 'team' where id = $1", [A.workspaceId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withCtx(A.workspaceId, A.userId, (c) => c.query("update workspaces set billing = '{}' where id = $1", [A.workspaceId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("nobody can make themselves a platform admin", async () => {
    await expect(asApp((c) => c.query("update users set is_platform_admin = true where id = $1", [A.userId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("the plan cannot be chosen at workspace creation", async () => {
    const r = await A.client.post("/workspaces", { name: "Sneaky", plan: "team", planId: "team" });
    expect(r.status).toBe(400);
    const ok = await A.client.post("/workspaces", { name: "Second" });
    expect(ok.status).toBe(201);
    expect((await A.client.get(`/workspaces/${ok.body.workspace.id}`)).body.workspace.plan.id).toBe("free");
  });
});

describe("Storage and cache isolation", () => {
  it("a workspace-scoped store refuses keys under another workspace's prefix", async () => {
    const storeB = t.deps.storage.scoped(B.workspaceId);
    const foreign = `w/${A.workspaceId}/datasets/${aDataset}/original`;
    await expect(storeB.get(foreign)).rejects.toMatchObject({ status: 403 });
    await expect(storeB.put(foreign, new Uint8Array([1]))).rejects.toMatchObject({ status: 403 });
    await expect(storeB.delete(foreign)).rejects.toMatchObject({ status: 403 });
    await expect(storeB.deletePrefix(`w/${A.workspaceId}/`)).rejects.toMatchObject({ status: 403 });
    await expect(storeB.get(`w/${B.workspaceId}/../${A.workspaceId}/datasets/x/original`)).rejects.toBeTruthy(); // traversal is not a way around the check
    await expect(new ScopedStore(t.deps.storage.raw, A.workspaceId).exists(foreign)).resolves.toBe(true);
  });

  it("stored objects are encrypted per key when a key is configured", async () => {
    const { EncryptedStore, LocalStore } = await import("../src/storage");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const inner = new LocalStore(mkdtempSync(join(tmpdir(), "enc-")));
    const enc = new EncryptedStore(inner, Buffer.alloc(32, 7));
    await enc.put("w/x/a", Buffer.from("secret,data\n1,2"));
    expect(Buffer.from(await inner.get("w/x/a")).includes(Buffer.from("secret"))).toBe(false);
    expect(Buffer.from(await enc.get("w/x/a")).toString()).toBe("secret,data\n1,2");
    // ciphertext moved to another key must not decrypt (key is bound as AAD)
    await inner.put("w/y/a", await inner.get("w/x/a"));
    await expect(enc.get("w/y/a")).rejects.toMatchObject({ code: "storage_corrupt" });
  });

  it("the parsed-frame cache is keyed by workspace: a cached version can't be served to another tenant", async () => {
    const cached = await t.deps.frames.get(A.workspaceId, aVersion, async () => { throw new Error("should already be cached or reload"); }).catch(() => null);
    void cached;
    // B asks for A's version id through B's own workspace: the tenant-scoped lookup finds no such version
    const { loadForAnalysis } = await import("../src/datasets/service");
    const { resolveWorkspace } = await import("../src/workspaces/service");
    const ctxB = await resolveWorkspace(t.deps, B.userId, B.workspaceId, "dataset.read");
    await expect(loadForAnalysis(t.deps, ctxB, bDataset, aVersion)).rejects.toMatchObject({ status: 422 });
    await expect(loadForAnalysis(t.deps, ctxB, aDataset)).rejects.toMatchObject({ status: 404 });
  });
});

describe("Platform admin sees metadata only", () => {
  it("non-admins are refused; admins get aggregates that contain no dataset content", async () => {
    expect((await A.client.get("/admin/overview")).status).toBe(403);
    expect((await A.client.get("/admin/workspaces")).status).toBe(403);
    await asOwner((c) => c.query("update users set is_platform_admin = true where id = $1", [B.userId]));
    const admin = new Client(t);
    await admin.post("/auth/login", { email: "bob@tenant-b.example", password: "Correct-Horse-Battery-9" });
    const ov = await admin.get("/admin/overview");
    expect(ov.status).toBe(200);
    expect(ov.body).toMatchObject({ users: 2, workspaces: 3, datasets: 2 });
    const wss = await admin.get("/admin/workspaces");
    expect(wss.body.workspaces).toHaveLength(3);
    const text = JSON.stringify(wss.body) + JSON.stringify((await admin.get("/admin/jobs")).body) + JSON.stringify((await admin.get("/admin/audit")).body);
    expect(text).not.toMatch(/Aura Watch|Retail sales|demo-retail/);
    await asOwner((c) => c.query("update users set is_platform_admin = false where id = $1", [B.userId]));
    expect((await admin.get("/admin/overview")).status).toBe(403); // revocation is immediate
    // the admin role gives no access to tenant data through the normal routes either
    expect((await admin.get(`/workspaces/${A.workspaceId}/datasets`)).status).toBe(404);
  });
});
