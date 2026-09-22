import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { materializeDashboard, narrow, planFilters, starterQuestions, type Filter, type WidgetSpec } from "@verinum/core";
import { toCsv, toXlsx } from "@verinum/ingest";
import { audit } from "../audit";
import type { Deps } from "../context";
import { allMatching, queryRows } from "../datasets/explorer";
import { getArtifacts, loadForAnalysis } from "../datasets/service";
import { badRequest, forbidden, notFound, unprocessable } from "../errors";
import { consume } from "../usage";
import { inWorkspace, isUuid } from "../workspaces/service";
import { parse, workspaceFor } from "./util";

const Scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
export const FilterSchema = z.object({
  column: z.string().min(1).max(200),
  op: z.enum(["eq", "neq", "in", "not_in", "contains", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"]),
  value: Scalar.nullable().optional(),
  values: z.array(Scalar).max(200).optional(),
}).strict();
export const Filters = z.array(FilterSchema).max(20).default([]);

const WidgetSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().min(1).max(200), why: z.string().max(400).default(""),
  tool: z.string().min(1).max(60), params: z.record(z.unknown()).refine((p) => JSON.stringify(p).length <= 4000, "params too large"),
  size: z.enum(["sm", "md", "lg", "full"]).default("md"),
});

export async function registerAnalysisRoutes(app: FastifyInstance, deps: Deps) {
  const base = "/workspaces/:workspaceId/datasets/:datasetId";
  const dsId = (req: { params: unknown }) => (req.params as { datasetId: string }).datasetId;
  const heavy = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  app.get(`${base}/profile`, async (req) => {
    const a = await getArtifacts(deps, await workspaceFor(deps, req, "dataset.read"), dsId(req));
    return { dataset: a.dataset, version: a.version, profile: a.profile, document: a.document };
  });

  app.get(`${base}/quality`, async (req) => {
    const a = await getArtifacts(deps, await workspaceFor(deps, req, "dataset.read"), dsId(req));
    return { version: a.version, quality: a.profile.quality, transformations: a.transformations, suggestions: a.suggestions, warnings: a.version.warnings };
  });

  app.get(`${base}/insights`, async (req) => {
    const a = await getArtifacts(deps, await workspaceFor(deps, req, "dataset.read"), dsId(req));
    return { version: a.version, report: a.insights };
  });

  app.get(`${base}/starter-questions`, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.read");
    const d = await loadForAnalysis(deps, ctx, dsId(req));
    return { questions: starterQuestions(d.ctx) };
  });

  /* ---- dashboard: the stored plan, or the caller's widgets, over optional filters ---- */
  app.post(`${base}/dashboard`, heavy, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.read");
    const body = parse(z.object({
      filters: Filters, dateFrom: z.string().max(20).optional(), dateTo: z.string().max(20).optional(),
      widgets: z.array(WidgetSchema).max(40).optional(), dashboardId: z.string().uuid().optional(),
    }).strict(), req.body ?? {});
    const d = await loadForAnalysis(deps, ctx, dsId(req));
    const plan = d.plan as { widgets: WidgetSpec[]; filters: unknown[] };
    let specs: WidgetSpec[] = body.widgets as WidgetSpec[] | undefined ?? plan.widgets;
    if (body.dashboardId) {
      const saved = await inWorkspace(deps, ctx, async (q) => (await q.query<{ widgets: WidgetSpec[] }>("select widgets from dashboards where id = $1 and dataset_id = $2", [body.dashboardId, dsId(req)])).rows[0]);
      if (!saved) throw notFound("Dashboard");
      specs = saved.widgets;
    }
    const view = materializeDashboard(d.ctx, specs, deps.registry, { filters: body.filters as Filter[], dateFrom: body.dateFrom, dateTo: body.dateTo });
    return { view, filters: plan.filters, dataset: d.dataset, version: d.version };
  });

  /* ---- saved dashboards ---- */
  app.get(`${base}/dashboards`, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.read");
    return { dashboards: (await inWorkspace(deps, ctx, async (q) => (await q.query<{ id: string; name: string; widgets: unknown[]; updated_at: Date }>("select id, name, widgets, updated_at from dashboards where dataset_id = $1 order by created_at", [dsId(req)])).rows)).map((r) => ({ id: r.id, name: r.name, widgets: r.widgets, updatedAt: r.updated_at })) };
  });

  const saveBody = z.object({ name: z.string().trim().min(1).max(120), widgets: z.array(WidgetSchema).min(1).max(40) }).strict();
  const assertTools = (widgets: { tool: string }[]) => {
    const known = new Set(deps.registry.names());
    for (const w of widgets) if (!known.has(w.tool)) throw badRequest(`Unknown tool "${w.tool}".`);
  };

  app.post(`${base}/dashboards`, async (req, reply) => {
    const ctx = await workspaceFor(deps, req, "dashboard.save");
    const body = parse(saveBody, req.body);
    assertTools(body.widgets);
    await loadForAnalysis(deps, ctx, dsId(req)); // also proves the dataset exists in this workspace
    const id = await inWorkspace(deps, ctx, async (q) => {
      const n = (await q.query<{ n: number }>("select count(*)::int n from dashboards where dataset_id = $1", [dsId(req)])).rows[0]!.n;
      if (n >= 25) throw unprocessable("A dataset can have up to 25 saved dashboards.", "limit");
      const r = await q.query<{ id: string }>("insert into dashboards (workspace_id, dataset_id, name, widgets, created_by) values ($1,$2,$3,$4,$5) returning id", [ctx.workspaceId, dsId(req), body.name, JSON.stringify(body.widgets), ctx.userId]);
      await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "dashboard.save", targetType: "dashboard", targetId: r.rows[0]!.id, ip: req.ip, requestId: req.id });
      return r.rows[0]!.id;
    });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/dashboards/:id`, async (req) => {
    const ctx = await workspaceFor(deps, req, "dashboard.save");
    const id = (req.params as { id: string }).id;
    if (!isUuid(id)) throw notFound("Dashboard");
    const body = parse(saveBody, req.body);
    assertTools(body.widgets);
    const n = await inWorkspace(deps, ctx, async (q) => (await q.query("update dashboards set name = $3, widgets = $4, updated_at = now() where id = $1 and dataset_id = $2", [id, dsId(req), body.name, JSON.stringify(body.widgets)])).rowCount);
    if (!n) throw notFound("Dashboard");
    return { ok: true };
  });

  app.delete(`${base}/dashboards/:id`, async (req) => {
    const ctx = await workspaceFor(deps, req, "dashboard.save");
    const id = (req.params as { id: string }).id;
    if (!isUuid(id)) throw notFound("Dashboard");
    const n = await inWorkspace(deps, ctx, async (q) => (await q.query("delete from dashboards where id = $1 and dataset_id = $2", [id, dsId(req)])).rowCount);
    if (!n) throw notFound("Dashboard");
    return { ok: true };
  });

  /* ---- tools: the same registry the AI uses, callable directly ---- */
  app.get(`${base}/tools`, async (req) => {
    const d = await loadForAnalysis(deps, await workspaceFor(deps, req, "dataset.read"), dsId(req));
    return { tools: deps.registry.offered(d.ctx), unavailable: deps.registry.unavailable(d.ctx) };
  });

  app.post(`${base}/tools/run`, heavy, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.read");
    const body = parse(z.object({ tool: z.string().min(1).max(60), params: z.record(z.unknown()).default({}), filters: Filters }).strict(), req.body);
    const d = await loadForAnalysis(deps, ctx, dsId(req));
    const scope = body.filters.length ? narrow(d.ctx, body.filters as Filter[]) : d.ctx;
    const r = deps.registry.call(scope, body.tool, body.params);
    if (!r.ok) throw unprocessable(r.message, r.code, r.hint ? { hint: r.hint } : undefined);
    return { summary: r.summary, facts: r.facts, chart: r.chart, provenance: r.provenance, data: r.data };
  });

  /* ---- explorer ---- */
  app.get(`${base}/columns`, async (req) => {
    const d = await loadForAnalysis(deps, await workspaceFor(deps, req, "dataset.read"), dsId(req));
    return { columns: d.profile.columns, filters: planFilters(d.ctx), rowCount: d.frame.rowCount };
  });

  app.post(`${base}/rows`, heavy, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.read");
    const body = parse(z.object({
      filters: Filters, search: z.string().max(100).optional(), offset: z.number().int().min(0).max(2_000_000).default(0), limit: z.number().int().min(1).max(200).default(50),
      sort: z.object({ column: z.string().max(200), dir: z.enum(["asc", "desc"]) }).nullable().optional(), columns: z.array(z.string().max(200)).max(500).optional(),
    }).strict(), req.body);
    const d = await loadForAnalysis(deps, ctx, dsId(req));
    return queryRows(d.ctx, { ...body, filters: body.filters as Filter[] });
  });

  /* ---- exports (metered, audited; formula-injection-safe) ---- */
  app.post(`${base}/export`, heavy, async (req, reply) => {
    const ctx = await workspaceFor(deps, req, "dataset.export");
    if (!ctx.plan.features.export) throw forbidden("Exports aren't included in your plan.");
    const body = parse(z.object({
      format: z.enum(["csv", "xlsx", "json"]).default("csv"), filters: Filters, search: z.string().max(100).optional(),
      sort: z.object({ column: z.string().max(200), dir: z.enum(["asc", "desc"]) }).nullable().optional(), columns: z.array(z.string().max(200)).max(500).optional(),
    }).strict(), req.body);
    const d = await loadForAnalysis(deps, ctx, dsId(req));
    const cap = ctx.plan.limits.maxRowsPerDataset < 0 ? 1_000_000 : ctx.plan.limits.maxRowsPerDataset;
    const out = allMatching(d.ctx, { ...body, filters: body.filters as Filter[] }, cap);
    await consume(deps, ctx, "export", { format: body.format, rows: out.rows.length });
    await inWorkspace(deps, ctx, (q) => audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "dataset.export", targetType: "dataset", targetId: dsId(req), meta: { format: body.format, rows: out.rows.length }, ip: req.ip, requestId: req.id }));
    const safeName = d.dataset.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "export";
    reply.header("content-disposition", `attachment; filename="${safeName}.${body.format}"`);
    if (body.format === "csv") return reply.type("text/csv; charset=utf-8").send(toCsv(out));
    if (body.format === "xlsx") return reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(await toXlsx(out, d.dataset.name)));
    return reply.type("application/json").send({ columns: out.columns, rows: out.rows, truncated: out.truncated });
  });

}
