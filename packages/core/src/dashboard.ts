/**
 * Dashboard planning and materialisation.
 *
 * A dashboard is a list of widget specs, each of which is just "run this tool with these params".
 * Dashboards therefore go through exactly the same registry as the AI chat, so a number on a
 * dashboard tile and the same number in an answer can never differ, and every widget carries its
 * provenance. The plan is derived from the profile (what the data can support); users can hide,
 * reorder or add widgets by storing their own specs, and filters narrow every widget at once.
 */
import { narrow, type AnalysisContext } from "./context";
import { candidateDimensions } from "./insights/generators";
import { computeKpis, type Kpi } from "./kpis";
import type { ChartSpec } from "./charts";
import type { Fact, Provenance } from "./facts";
import { dateRangeFromKey, type Filter } from "./analytics/filter";
import { formatIsoDate } from "./time";
import type { ToolRegistry } from "./tools/registry";
import type { DatasetProfile } from "./types";

export type WidgetSize = "sm" | "md" | "lg" | "full";

export interface WidgetSpec {
  id: string;
  title: string;
  /** one sentence: why this widget is on the dashboard */
  why: string;
  tool: string;
  params: Record<string, unknown>;
  size: WidgetSize;
}

export interface DashboardFilterSpec {
  column: string;
  label: string;
  kind: "category" | "date";
  values?: { value: string; count: number }[];
  min?: string;
  max?: string;
}

export interface DashboardPlan {
  version: 1;
  widgets: WidgetSpec[];
  filters: DashboardFilterSpec[];
}

export interface WidgetResult {
  spec: WidgetSpec;
  status: "ok" | "unavailable";
  chart?: ChartSpec;
  summary?: string;
  facts?: Fact[];
  provenance?: Provenance;
  /** why an unavailable widget is unavailable (shown instead of an empty chart) */
  reason?: string;
}

export interface DashboardView {
  rowsInScope: number;
  totalRows: number;
  appliedFilters: string[];
  kpis: Kpi[];
  widgets: WidgetResult[];
  notes: string[];
}

const label = (n: string) => n.replace(/[_-]+/g, " ");

/** Chooses widgets from what the dataset supports. Deterministic: same profile, same plan. */
export function planDashboard(ctx: AnalysisContext): DashboardPlan {
  const p = ctx.profile;
  const caps = p.capabilities;
  const lead = caps.leadMetric;
  const widgets: WidgetSpec[] = [];
  const add = (w: WidgetSpec) => { if (!widgets.some((x) => x.id === w.id)) widgets.push(w); };
  const leadName = lead ? label(lead) : "records";
  const leadP: Record<string, unknown> = lead ? { metric: lead } : {};

  if (caps.timeSeries) {
    add({ id: "trend", title: `${cap(leadName)} over time`, why: "Shows the shape of the business across complete periods; partial edge periods are excluded.", tool: "time_series", params: { ...leadP }, size: "full" });
  }
  const dims = candidateDimensions(ctx, 6);
  const chartDims = dims.filter((d) => d.meaning !== "product" && d.meaning !== "customer");
  for (const d of chartDims.slice(0, 3)) {
    add({ id: `by:${d.name}`, title: `${cap(leadName)} by ${label(d.name)}`, why: `${d.name} is a bounded category, so it works as a breakdown.`, tool: "group_by", params: { dimension: d.name, ...leadP, limit: 12 }, size: "md" });
  }
  if (caps.product) {
    add({ id: "top-products", title: `Top ${label(caps.product)} values by ${leadName}`, why: "Rankings answer 'what sells best'.", tool: "top_n", params: { dimension: caps.product, ...leadP, n: 10 }, size: "md" });
  }
  if (caps.forecast) {
    add({ id: "forecast", title: `${cap(leadName)} outlook`, why: "Enough complete history exists for a forecast; the range shows the uncertainty.", tool: "forecast", params: { ...leadP }, size: "lg" });
  }
  if (caps.margin) {
    add({ id: "margin-trend", title: "Margin over time", why: "Margin is derived from revenue and profit amounts, never averaged from row-level rates.", tool: "time_series", params: { metric: "margin" }, size: "lg" });
    const d = chartDims[0];
    if (d) add({ id: `profit:${d.name}`, title: `Profitability by ${label(d.name)}`, why: "Compares margin across groups so low-margin groups stand out even when their revenue is large.", tool: "profitability", params: { dimension: d.name, limit: 10 }, size: "md" });
  }
  if (caps.timeSeries) {
    add({ id: "anomalies", title: `Unusual periods in ${leadName}`, why: "Highlights periods that deviate from the trend after removing it.", tool: "anomalies", params: { ...leadP }, size: "md" });
  }
  if (chartDims.length >= 2) {
    const [a, b] = chartDims;
    add({ id: `xtab:${a!.name}:${b!.name}`, title: `${cap(leadName)}: ${label(a!.name)} × ${label(b!.name)}`, why: "A two-way view shows combinations that a single breakdown hides.", tool: "cross_tab", params: { row_dimension: a!.name, column_dimension: b!.name, ...leadP }, size: "md" });
  }
  if (lead) add({ id: "distribution", title: `Distribution of ${leadName}`, why: "Shows typical values and the tail.", tool: "distribution", params: { column: lead }, size: "sm" });
  if (caps.stage) add({ id: "funnel", title: "Funnel", why: "A stage column exists.", tool: "funnel", params: { stage_column: caps.stage }, size: "md" });
  if (caps.cohort) add({ id: "cohort", title: "Customer retention by cohort", why: "Customers and dates exist, so repeat behaviour can be measured.", tool: "cohort_retention", params: {}, size: "lg" });
  if (caps.correlation) add({ id: "relationships", title: "Strongest relationship between measures", why: "Only relationships that are not arithmetic identities are shown.", tool: "correlation", params: {}, size: "md" });

  return { version: 1, widgets, filters: planFilters(ctx) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Filter controls the UI can offer: bounded categories and the event-date range. */
export function planFilters(ctx: AnalysisContext): DashboardFilterSpec[] {
  const out: DashboardFilterSpec[] = [];
  const p: DatasetProfile = ctx.profile;
  if (p.primaryDate && p.calendar) {
    out.push({ column: p.primaryDate, label: label(p.primaryDate), kind: "date", min: p.calendar.minIso, max: p.calendar.maxIso });
  }
  for (const c of candidateDimensions(ctx, 6)) {
    if (!c.top?.length) continue;
    out.push({ column: c.name, label: label(c.name), kind: "category", values: c.top.filter((t) => t.value !== "").slice(0, 25).map((t) => ({ value: t.value, count: t.count })) });
  }
  return out;
}

export interface MaterializeOptions {
  filters?: Filter[];
  maxKpis?: number;
  /** date-range filter applied through the tools' own date_from / date_to */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Runs every widget through the registry. A widget the data cannot support is reported as
 * unavailable with the reason — never dropped silently, never faked.
 */
export function materializeDashboard(base: AnalysisContext, specs: WidgetSpec[], registry: ToolRegistry, o: MaterializeOptions = {}): DashboardView {
  const filters: Filter[] = [...(o.filters ?? [])];
  const dateCol = base.profile.primaryDate;
  if (dateCol && (o.dateFrom || o.dateTo)) {
    const a = o.dateFrom ? dateRangeFromKey(o.dateFrom) : null, b = o.dateTo ? dateRangeFromKey(o.dateTo) : null;
    if (a) filters.push({ column: dateCol, op: "gte", value: formatIsoDate(a[0]) });
    if (b) filters.push({ column: dateCol, op: "lte", value: formatIsoDate(b[1]) });
  }
  const ctx = filters.length ? narrow(base, filters) : base;
  const notes: string[] = [];
  let kpis: Kpi[] = [];
  if (ctx.rowCount > 0) {
    try { kpis = computeKpis(ctx, { max: o.maxKpis ?? 6 }); } catch { notes.push("Headline metrics could not be computed for this selection."); }
  } else {
    notes.push("No rows match the current filters.");
  }
  const widgets: WidgetResult[] = specs.map((spec) => {
    if (ctx.rowCount === 0) return { spec, status: "unavailable", reason: "No rows match the current filters." };
    const r = registry.call(ctx, spec.tool, spec.params);
    if (!r.ok) return { spec, status: "unavailable", reason: r.message };
    return { spec, status: "ok", chart: r.chart, summary: r.summary, facts: r.facts, provenance: r.provenance };
  });
  return { rowsInScope: ctx.rowCount, totalRows: base.rowCount, appliedFilters: ctx.filterText, kpis, widgets, notes };
}


