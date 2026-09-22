import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asOwner, demoDataset, drain, initDb, makeApp, resetData, signup, uploadAndProcess, type TestApp } from "./helpers/harness";

let t: TestApp;
beforeAll(async () => { await initDb(); t = await makeApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetData(); });

const ws = (s: { workspaceId: string }, p = "") => `/workspaces/${s.workspaceId}${p}`;

describe("acceptance: upload → processed → insights, dashboard, forecast", () => {
  it("processes the demo retail CSV end to end with progress, quality, KPIs, insights, dashboard and a forecast", async () => {
    const s = await signup(t);
    const up = await s.client.post(ws(s, "/datasets/demo"));
    expect(up.status).toBe(202);
    const id = up.body.datasetId;

    // before the worker runs: queued, with a job to poll
    const early = await s.client.get(ws(s, `/datasets/${id}`));
    expect(early.body.status).toBe("queued");
    const job = await s.client.get(ws(s, `/jobs/${up.body.jobId}`));
    expect(job.body).toMatchObject({ status: "queued", kind: "dataset.process" });
    expect(job.body.stages).toHaveLength(7);

    await drain(t);
    const d = (await s.client.get(ws(s, `/datasets/${id}`))).body;
    expect(d).toMatchObject({ status: "ready", isDemo: true, sourceFormat: "csv" });
    expect(d.version).toMatchObject({ rowCount: 6764, columnCount: 16, version: 1, status: "ready" });
    const done = await s.client.get(ws(s, `/jobs/${up.body.jobId}`));
    expect(done.body.status).toBe("succeeded");
    expect(done.body.progress.pct).toBe(100);

    const q = (await s.client.get(ws(s, `/datasets/${id}/quality`))).body;
    expect(q.quality.score).toBe(74);
    expect(q.suggestions.some((x: any) => x.kind === "remove_duplicates")).toBe(true);
    expect(q.transformations.length).toBeGreaterThan(0);

    const prof = (await s.client.get(ws(s, `/datasets/${id}/profile`))).body.profile;
    expect(prof.capabilities).toMatchObject({ revenue: "Sales", profit: "Profit", margin: true, timeSeries: true, forecast: true });

    const ins = (await s.client.get(ws(s, `/datasets/${id}/insights`))).body.report;
    expect(ins.insights.length).toBeGreaterThan(3);
    expect(ins.insights[0].score).toBeGreaterThanOrEqual(ins.insights[1].score);
    expect(ins.insights[0].evidence.tool).toBeTruthy();

    const dash = (await s.client.post(ws(s, `/datasets/${id}/dashboard`), {})).body;
    expect(dash.view.rowsInScope).toBe(6764);
    expect(dash.view.kpis.length).toBeGreaterThan(2);
    const widgetIds = dash.view.widgets.map((w: any) => w.spec.id);
    expect(widgetIds).toContain("trend");
    expect(widgetIds).toContain("forecast");
    expect(dash.view.widgets.find((w: any) => w.spec.id === "forecast").status).toBe("ok");
    expect(dash.filters.length).toBeGreaterThan(0);

    // dashboard filters narrow every widget and the KPIs together
    const filtered = (await s.client.post(ws(s, `/datasets/${id}/dashboard`), { filters: [{ column: "Region", op: "eq", value: "EMEA" }] })).body;
    expect(filtered.view.rowsInScope).toBeLessThan(6764);
    expect(filtered.view.appliedFilters[0]).toMatch(/Region/);
  });

  it("cross-checks: the tool endpoint returns exact, provenance-carrying results (top 5 products)", async () => {
    const s = await signup(t);
    const { id } = await demoDataset(t, s);
    const r = await s.client.post(ws(s, `/datasets/${id}/tools/run`), { tool: "top_n", params: { dimension: "Product", n: 5 } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toContain("506.5K");
    expect(r.body.provenance.rowsConsidered).toBe(6764);
    expect(r.body.provenance.tool).toBe("top_n");
    const bad = await s.client.post(ws(s, `/datasets/${id}/tools/run`), { tool: "top_n", params: { dimension: "Nope" } });
    expect(bad.status).toBe(422);
  });

  it("reprocessing with cleaning choices creates a new version; the original is preserved", async () => {
    const s = await signup(t);
    const { id } = await demoDataset(t, s);
    const r = await s.client.post(ws(s, `/datasets/${id}/reprocess`), { options: { removeDuplicates: true } });
    expect(r.status).toBe(202);
    expect(r.body.version).toBe(2);
    await drain(t);
    const d = (await s.client.get(ws(s, `/datasets/${id}`))).body;
    expect(d.version).toMatchObject({ version: 2, rowCount: 6750 });
    const versions = (await s.client.get(ws(s, `/datasets/${id}/versions`))).body.versions;
    expect(versions.map((v: any) => [v.version, v.rowCount])).toEqual([[2, 6750], [1, 6764]]);
    const log = (await s.client.get(ws(s, `/datasets/${id}/quality`))).body.transformations;
    expect(log.some((x: any) => x.kind === "remove_duplicates" && x.affected === 14)).toBe(true);
    // dismissed suggestion no longer offered; rolling back restores the earlier analysis
    expect((await s.client.get(ws(s, `/datasets/${id}/quality`))).body.suggestions.some((x: any) => x.kind === "remove_duplicates")).toBe(false);
    const v1 = versions.find((v: any) => v.version === 1);
    expect((await s.client.post(ws(s, `/datasets/${id}/versions/${v1.id}/activate`))).status).toBe(200);
    expect((await s.client.get(ws(s, `/datasets/${id}`))).body.version.rowCount).toBe(6764);
  });

  it("explorer: pages, sorts (blanks last), searches and filters rows; columns come with profiles", async () => {
    const s = await signup(t);
    const { id } = await demoDataset(t, s);
    const page = (await s.client.post(ws(s, `/datasets/${id}/rows`), { limit: 5, sort: { column: "Sales", dir: "desc" } })).body;
    expect(page.rows).toHaveLength(5);
    expect(page.matched).toBe(6764);
    const salesIdx = page.columns.findIndex((c: any) => c.name === "Sales");
    expect(page.rows[0][salesIdx]).toBeGreaterThanOrEqual(page.rows[1][salesIdx]);
    const dateIdx = page.columns.findIndex((c: any) => c.name === "Date");
    expect(page.rows[0][dateIdx]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const f = (await s.client.post(ws(s, `/datasets/${id}/rows`), { limit: 3, filters: [{ column: "Region", op: "eq", value: "EMEA" }], search: "aura" })).body;
    expect(f.matched).toBeGreaterThan(0);
    expect(f.matched).toBeLessThan(6764);
    expect((await s.client.post(ws(s, `/datasets/${id}/rows`), { limit: 1000 })).status).toBe(400);
    expect((await s.client.get(ws(s, `/datasets/${id}/columns`))).body.columns).toHaveLength(16);
  });

  it("saved dashboards: create, list, render by id, update, delete; unknown tools are refused", async () => {
    const s = await signup(t);
    const { id } = await demoDataset(t, s);
    const widgets = [{ id: "w1", title: "Top products", tool: "top_n", params: { dimension: "Product", n: 3 }, size: "md" }];
    expect((await s.client.post(ws(s, `/datasets/${id}/dashboards`), { name: "Bad", widgets: [{ ...widgets[0], tool: "rm_rf" }] })).status).toBe(400);
    const c = await s.client.post(ws(s, `/datasets/${id}/dashboards`), { name: "Mine", widgets });
    expect(c.status).toBe(201);
    const list = (await s.client.get(ws(s, `/datasets/${id}/dashboards`))).body.dashboards;
    expect(list).toHaveLength(1);
    const view = (await s.client.post(ws(s, `/datasets/${id}/dashboard`), { dashboardId: c.body.id })).body.view;
    expect(view.widgets).toHaveLength(1);
    expect(view.widgets[0].status).toBe("ok");
    expect((await s.client.put(ws(s, `/datasets/${id}/dashboards/${c.body.id}`), { name: "Renamed", widgets })).status).toBe(200);
    expect((await s.client.delete(ws(s, `/datasets/${id}/dashboards/${c.body.id}`))).status).toBe(200);
    expect((await s.client.get(ws(s, `/datasets/${id}/dashboards`))).body.dashboards).toHaveLength(0);
  });

  it("exports CSV with formula-injection protection, and counts against the plan", async () => {
    const s = await signup(t);
    const evil = "Name,Amount\n=HYPERLINK(\"http://evil\"),10\n+cmd|' /C calc'!A0,20\nNormal,30\n";
    const { dataset } = await uploadAndProcess(t, s, "evil.csv", evil);
    expect(dataset.status).toBe("ready");
    const r = await s.client.post(ws(s, `/datasets/${dataset.id}/export`), { format: "csv" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.headers["content-disposition"]).toMatch(/attachment/);
    const lines = r.raw.replace(/^﻿/, "").split("\r\n");
    expect(lines[1]!.startsWith("\"'=HYPERLINK") || lines[1]!.startsWith("'=HYPERLINK")).toBe(true);
    expect(lines[2]).toContain("'+cmd");
    const usage = (await s.client.get(ws(s, "/usage"))).body;
    expect(usage.exports.used).toBe(1);
    const x = await s.client.post(ws(s, `/datasets/${dataset.id}/export`), { format: "xlsx" });
    expect(x.status).toBe(200);
    expect(x.raw.startsWith("PK")).toBe(true);
  });
});

describe("ingestion failures are reported, not swallowed", () => {
  it("fails a corrupt or empty upload with a readable reason and leaves the dataset failed", async () => {
    const s = await signup(t);
    const { dataset } = await uploadAndProcess(t, s, "broken.xlsx", Buffer.from("PK\u0003\u0004 definitely not a workbook"));
    expect(dataset.status).toBe("failed");
    expect(dataset.error).toBeTruthy();
    expect(dataset.error).not.toMatch(/at .*\.ts|stack/i);
    const empty = await s.client.upload(ws(s, "/datasets"), "empty.csv", "");
    expect(empty.status).toBe(400);
    const noFile = await s.client.post(ws(s, "/datasets"), {});
    expect(noFile.status).toBe(400);
  });

  it("detects format from content, not extension, and says so", async () => {
    const s = await signup(t);
    const { dataset } = await uploadAndProcess(t, s, "sales.pdf", "Date,Amount\n2025-01-01,10\n2025-01-02,20\n2025-01-03,30\n");
    expect(dataset.status).toBe("ready");
    expect(dataset.sourceFormat).toBe("csv");
    expect(dataset.version.warnings.join(" ")).toMatch(/extension/);
  });

  it("uploaded filenames are sanitised (path traversal, control characters)", async () => {
    const s = await signup(t);
    const r = await s.client.upload(ws(s, "/datasets"), "..\\..\\etc\\passwd\u0000.csv", "a,b\n1,2\n2,3\n");
    expect(r.status).toBe(202);
    const d = (await s.client.get(ws(s, `/datasets/${r.body.datasetId}`))).body;
    expect(d.sourceName).toBe("passwd.csv");
    const keys = await asOwner((c) => c.query("select storage_original from dataset_versions"));
    expect(keys.rows[0].storage_original).toMatch(/^w\/[0-9a-f-]{36}\/datasets\/[0-9a-f-]{36}\/original$/);
  });
});

describe("deleting datasets", () => {
  it("hides the dataset immediately and purges its stored files and rows", async () => {
    const s = await signup(t);
    const { id } = await demoDataset(t, s);
    expect((await s.client.delete(ws(s, `/datasets/${id}`))).status).toBe(200);
    expect((await s.client.get(ws(s, `/datasets/${id}`))).status).toBe(404);
    expect((await s.client.get(ws(s, "/datasets"))).body.datasets).toHaveLength(0);
    await drain(t);
    expect((await asOwner((c) => c.query("select count(*)::int n from datasets"))).rows[0].n).toBe(0);
    expect(await t.deps.storage.raw.deletePrefix(`w/${s.workspaceId}/`)).toBe(0); // nothing left to delete
  });
});
