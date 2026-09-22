/**
 * AnalysisContext: the dataset (frame + profile) with an optional active row filter, plus a cache
 * of derived series. Insights, dashboards and AI tools all compute through the same context, so a
 * number can never differ between the dashboard and the chat.
 */
import { Frame, type NumberColumn, type RowSet } from "./frame";
import { applyFilters, describeFilter, type Filter } from "./analytics/filter";
import { AnalyticsError } from "./analytics/errors";
import { aggregateColumn, type AggName } from "./analytics/aggregate";
import { buildTimeSeries, type SeriesAgg } from "./analytics/timeseries";
import { completePeriods, type CompleteSeries, type SeriesPoint, type TimeSeries } from "./analytics/periods";
import type { FormatContext, Unit } from "./format";
import type { ColumnProfile, DatasetProfile } from "./types";
import type { Grain } from "./time";

export interface AnalysisContext {
  frame: Frame;
  profile: DatasetProfile;
  /** the active subset (null = every row) */
  rows: RowSet;
  filters: Filter[];
  filterText: string[];
  fmt: FormatContext;
  datasetVersion?: string;
  rowCount: number;
  cache: Map<string, unknown>;
}

export function createContext(frame: Frame, profile: DatasetProfile, o: { filters?: Filter[]; datasetVersion?: string } = {}): AnalysisContext {
  const filters = o.filters ?? [];
  let rows: RowSet = null;
  let rowCount = frame.rowCount;
  if (filters.length) {
    const r = applyFilters(frame, filters);
    rows = r.rows;
    rowCount = r.matched;
  }
  return {
    frame, profile, rows, filters, filterText: filters.map(describeFilter),
    fmt: { currency: profile.currency }, datasetVersion: o.datasetVersion, rowCount, cache: new Map(),
  };
}

/** A context over a further-filtered subset (filters AND together). */
export function narrow(ctx: AnalysisContext, more: Filter[]): AnalysisContext {
  if (!more.length) return ctx;
  const r = applyFilters(ctx.frame, more, ctx.rows);
  return {
    ...ctx, rows: r.rows, filters: [...ctx.filters, ...more], filterText: [...ctx.filterText, ...more.map(describeFilter)],
    rowCount: r.matched, cache: new Map(),
  };
}

export function requireRows(ctx: AnalysisContext): void {
  if (ctx.rowCount === 0) throw new AnalyticsError("no_matching_rows", "No rows match the current filters.", "Loosen or remove a filter.");
}

/* -------------------------------- metrics ---------------------------------- */

export interface MetricSpec {
  column: string;
  agg: "sum" | "avg";
  additive: boolean;
  unit: Unit;
  /** multiply raw values by this before display (fraction percentages are stored ×0.01) */
  scale: number;
  profile: ColumnProfile;
}

export function metricSpec(ctx: AnalysisContext, column: string): MetricSpec {
  const p = ctx.profile.columns.find((c) => c.name === column);
  const col = ctx.frame.get(column);
  if (!p || !col) throw new AnalyticsError("unknown_column", `Column "${column}" does not exist.`, `Available columns: ${ctx.frame.names().join(", ")}`);
  if (col.kind !== "number") throw new AnalyticsError("wrong_type", `"${column}" is a ${col.kind} column, not a numeric measure.`);
  const unit: Unit = p.unit === "currency" ? "currency" : p.unit === "percent" ? "percent" : p.unit === "count" ? "count" : "number";
  let scale = 1;
  if (unit === "percent") {
    const nc = col as NumberColumn;
    const max = p.stats?.max ?? 1, min = p.stats?.min ?? 0;
    if (nc.meta.percent || (max <= 1.0001 && min >= -1.0001)) scale = 100;
  }
  const additive = p.additive === true;
  return { column, agg: additive ? "sum" : "avg", additive, unit, scale, profile: p };
}

export function aggregate(ctx: AnalysisContext, agg: AggName, column?: string, percentile?: number) {
  return aggregateColumn(ctx.frame, ctx.rows, agg, column, percentile);
}

/* -------------------------------- series ----------------------------------- */

export interface SeriesBundle {
  dateColumn: string;
  grain: Grain;
  series: TimeSeries;
  complete: CompleteSeries;
}

export interface SeriesRequest {
  metric?: string | null;
  agg?: SeriesAgg;
  grain?: Grain;
  dateColumn?: string;
}

/** Period series over the active rows, with the partial-period safeguard already applied. */
export function seriesFor(ctx: AnalysisContext, req: SeriesRequest = {}): SeriesBundle {
  const dateColumn = req.dateColumn ?? ctx.profile.primaryDate;
  if (!dateColumn) throw new AnalyticsError("no_date_column", "The dataset has no usable date column.");
  const grain = req.grain ?? ctx.profile.calendar?.grain ?? "month";
  const metric = req.metric ?? undefined;
  const agg: SeriesAgg = req.agg ?? (metric ? metricSpec(ctx, metric).agg : "count");
  const key = `series|${dateColumn}|${metric ?? ""}|${agg}|${grain}`;
  const hit = ctx.cache.get(key) as SeriesBundle | undefined;
  if (hit) return hit;
  requireRows(ctx);
  const series = buildTimeSeries(ctx.frame, ctx.rows, { dateColumn, metric, agg, grain });
  const complete = completePeriods(series);
  const b: SeriesBundle = { dateColumn, grain, series, complete };
  ctx.cache.set(key, b);
  return b;
}

/** The last two *consecutive* complete periods, or null when they are not adjacent. */
export function latestPair(points: SeriesPoint[]): { current: SeriesPoint; previous: SeriesPoint } | null {
  if (points.length < 2) return null;
  const current = points[points.length - 1]!, previous = points[points.length - 2]!;
  return current.ord - previous.ord === 1 ? { current, previous } : null;
}

/** Scales a raw value for display/facts (fraction percentages → percentage points). */
export const scaled = (spec: MetricSpec, v: number): number => v * spec.scale;

/** Per-period profit margin (%) = SUM(profit) ÷ SUM(revenue), on complete adjacent periods only (safeguard 8/10). */
export function marginSeries(ctx: AnalysisContext, grain?: Grain): { grain: Grain; points: SeriesPoint[]; notes: string[] } | null {
  const caps = ctx.profile.capabilities;
  if (!caps.margin || !caps.revenue || !caps.profit || !caps.timeSeries) return null;
  const r = seriesFor(ctx, { metric: caps.revenue, agg: "sum", grain }), p = seriesFor(ctx, { metric: caps.profit, agg: "sum", grain });
  const pm = new Map(p.complete.points.map((x) => [x.ord, x]));
  const points: SeriesPoint[] = [];
  for (const x of r.complete.points) {
    const y = pm.get(x.ord);
    if (y && x.value > 0) points.push({ ...x, value: (y.value / x.value) * 100 });
  }
  return { grain: r.grain, points, notes: r.complete.notes };
}
