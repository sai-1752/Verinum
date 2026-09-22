import { AnalyticsError } from "../analytics/errors";
import { detectSeriesAnomalies } from "../analytics/anomaly";
import { comparePeriods, type PeriodComparison } from "../analytics/compare";
import { forecast } from "../analytics/forecast";
import { seasonalityAnalysis } from "../analytics/seasonality";
import { trendAnalysis } from "../analytics/trend";
import { volumeVsMargin } from "../analytics/profitability";
import type { SeriesPoint } from "../analytics/periods";
import type { SeriesAgg } from "../analytics/timeseries";
import { latestPair, marginSeries, metricSpec, seriesFor, type AnalysisContext } from "../context";
import type { ChartSpec } from "../charts";
import type { Unit } from "../format";
import { forecastNarrative } from "../narrative";
import { linreg, median } from "../stats";
import { ordinalFromKey, periodKey, seasonLength, type Grain } from "../time";
import { candidateDimensions, contiguous } from "../insights/generators";
import { pickMetric } from "./basic";
import { Builder, COMMON_PROPS, clampInt, jsonSafe, normalizePeriodKey, resolveDimension, scopeFor } from "./helpers";
import type { ToolDef } from "./registry";

const GRAIN_ENUM = ["day", "week", "month", "quarter", "year"] as const;
const needTime = (ctx: AnalysisContext) => ctx.profile.capabilities.timeSeries ? null : (ctx.profile.capabilities.unavailable.timeSeries ?? "Trends over time aren't available for this dataset.");
const needForecast = (ctx: AnalysisContext) => ctx.profile.capabilities.forecast ? null : (ctx.profile.capabilities.unavailable.forecast ?? "Forecasting isn't available for this dataset.");
const needSeason = (ctx: AnalysisContext) => ctx.profile.capabilities.seasonality ? null : (ctx.profile.capabilities.unavailable.seasonality ?? "Seasonality isn't available for this dataset.");

const SERIES_PROPS = {
  metric: { type: "string", description: "Numeric column, or 'margin' for profit margin %. Omit for the lead metric (e.g. revenue)." },
  agg: { type: "string", enum: ["sum", "avg", "count", "distinct_count", "min", "max"], description: "Defaults to sum for additive measures, avg for prices/rates." },
  grain: { type: "string", enum: GRAIN_ENUM, description: "Period size. Defaults to the dataset's natural grain." },
  ...COMMON_PROPS,
} as const;

export interface ToolSeries {
  metric: string | null;
  agg: SeriesAgg;
  label: string;
  unit: Unit;
  scale: number;
  additive: boolean;
  grain: Grain;
  all: SeriesPoint[];
  points: SeriesPoint[];
  notes: string[];
  isMargin: boolean;
}

export function resolveSeries(ctx: AnalysisContext, p: Record<string, unknown>): ToolSeries {
  const ref = String(p.metric ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const grain = p.grain as Grain | undefined;
  if (ref === "margin" || ref === "profitmargin") {
    const ms = marginSeries(ctx, grain);
    if (!ms) throw new AnalyticsError("not_available", ctx.profile.capabilities.unavailable.margin ?? "Margin isn't available for this dataset.");
    return { metric: "margin", agg: "avg", label: "Profit margin", unit: "percent", scale: 1, additive: false, grain: ms.grain, all: ms.points, points: ms.points, notes: ms.notes, isMargin: true };
  }
  const m = pickMetric(ctx, p);
  if (!["sum", "avg", "count", "distinct_count", "min", "max"].includes(m.agg)) throw new AnalyticsError("invalid_argument", `Aggregation "${m.agg}" is not supported for time series; use sum, avg, count, distinct_count, min or max.`);
  const b = seriesFor(ctx, { metric: m.column?.name, agg: m.agg as SeriesAgg, grain });
  return { metric: m.column?.name ?? null, agg: m.agg as SeriesAgg, label: m.label, unit: m.unit, scale: m.scale, additive: m.additive, grain: b.grain, all: b.series.points, points: b.complete.points, notes: b.complete.notes, isMargin: false };
}

const pctGuard = (cur: number, prev: number, med: number): number | null =>
  Math.abs(prev) < 1e-9 || Math.abs(prev) < 0.1 * med ? null : ((cur - prev) / Math.abs(prev)) * 100;

/* ------------------------------- time_series --------------------------------- */

const timeSeriesTool: ToolDef = {
  name: "time_series",
  description: "A metric over time (by day, week, month, quarter or year), with period-over-period change. Partial periods at the edges of the data are shown but flagged and never used for comparisons. Use for 'sales by month', 'how did X evolve'.",
  parameters: { properties: { ...SERIES_PROPS, limit: { type: "integer", minimum: 3, maximum: 120, default: 24, description: "Show only the most recent N periods" } } },
  gate: needTime,
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const s = resolveSeries(sc.ctx, p);
    const b = new Builder("time_series", sc.ctx, { metric: s.metric, agg: s.agg, grain: s.grain, limit: p.limit, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    for (const n of s.notes) b.caveat(n);
    const completeOrds = new Set(s.points.map((x) => x.ord));
    const limit = clampInt(p.limit, 3, 120, 24);
    const shown = s.all.slice(-limit);
    const med = median(s.points.map((x) => Math.abs(x.value)));
    const rows = shown.map((pt) => {
      const idx = s.points.findIndex((x) => x.ord === pt.ord);
      const prev = idx > 0 && s.points[idx - 1]!.ord === pt.ord - 1 ? s.points[idx - 1]! : null;
      const pct = prev ? pctGuard(pt.value, prev.value, med) : null;
      const vf = b.fs.num(`${pt.period}: ${s.label}`, pt.value * s.scale, s.unit);
      const cf = pct !== null ? b.fs.num(`${pt.period}: change vs previous ${s.grain}`, pct, "percent", { signed: true }) : null;
      return { period: pt.period, value: pt.value * s.scale, display: vf.display, complete: completeOrds.has(pt.ord), rows: pt.n, pctChange: pct, pctChangeDisplay: cf?.display ?? null };
    });
    const partial = shown.filter((x) => !completeOrds.has(x.ord));
    if (partial.length) b.caveat(`${partial.map((x) => x.period).join(", ")} ${partial.length > 1 ? "are" : "is"} only partly covered by the data and excluded from trends and comparisons.`);
    if (s.all.length > shown.length) b.caveat(`Only the most recent ${b.fs.num("Periods shown", shown.length, "count").display} of ${b.fs.num("Periods available", s.all.length, "count").display} periods are shown.`);
    const vals = s.points.map((x) => x.value * s.scale);
    const n = b.fs.num("Complete periods", s.points.length, "count");
    let summary = `${s.label} by ${s.grain}: ${n.display} complete ${s.grain}s`;
    if (s.points.length) {
      const first = b.fs.text("First complete period", s.points[0]!.period, "date"), last = b.fs.text("Last complete period", s.points[s.points.length - 1]!.period, "date");
      summary += ` (${first.display} to ${last.display}).`;
      let hiI = 0, loI = 0;
      for (let i = 1; i < vals.length; i++) { if (vals[i]! > vals[hiI]!) hiI = i; if (vals[i]! < vals[loI]!) loI = i; }
      const hi = b.fs.num("Highest period value", vals[hiI]!, s.unit), lo = b.fs.num("Lowest period value", vals[loI]!, s.unit);
      const avg = b.fs.num(`Average per ${s.grain}`, vals.reduce((a, c) => a + c, 0) / vals.length, s.unit);
      summary += ` Highest: ${s.points[hiI]!.period} at ${hi.display}; lowest: ${s.points[loI]!.period} at ${lo.display}; average ${avg.display} per ${s.grain}.`;
      if (s.additive) { const tot = b.fs.num("Total over complete periods", vals.reduce((a, c) => a + c, 0), s.unit); summary += ` Total over complete periods: ${tot.display}.`; }
      const pair = latestPair(s.points);
      if (pair) {
        const pct = pctGuard(pair.current.value, pair.previous.value, med);
        if (pct !== null) { const f = b.fs.num("Latest change", pct, "percent", { signed: true }); summary += ` The latest complete ${s.grain}, ${pair.current.period}, changed ${f.display} versus ${pair.previous.period}.`; }
      }
    } else summary += ".";
    // The chart draws complete periods only: a partly covered edge period would plot as a false collapse (or spike).
    // Partial periods stay in the returned table, flagged `complete: false`.
    const drawn = shown.filter((x) => completeOrds.has(x.ord));
    const chart: ChartSpec = { kind: "line", title: `${s.label} by ${s.grain}`, unit: s.unit, currency: ctx.fmt.currency, x: drawn.map((x) => x.period), series: [{ name: s.label, values: drawn.map((x) => x.value * s.scale) }] };
    return b.done(jsonSafe({ metric: s.metric, agg: s.agg, grain: s.grain, points: rows }), { summary, method: `${s.agg.toUpperCase()} per calendar ${s.grain} using civil dates (no time-zone shifts); edge periods with too little coverage are flagged as partial.`, chart });
  },
};

/* ----------------------------- period resolution ----------------------------- */

interface PeriodPair { a: string; b: string; grain: Grain; defaulted: boolean }

function resolvePeriods(ctx: AnalysisContext, s: ToolSeries, p: Record<string, unknown>): PeriodPair {
  const compareTo = (p.compare_to as string) ?? "previous";
  const rawA = p.period_a ? normalizePeriodKey(String(p.period_a)) : null;
  if (p.period_a && !rawA) throw new AnalyticsError("invalid_argument", `"${p.period_a}" is not a recognised period.`, "Use YYYY-MM-DD, YYYY-MM, YYYY-Qn or YYYY (for example 2026-05).");
  const rawB = p.period_b ? normalizePeriodKey(String(p.period_b)) : null;
  if (p.period_b && !rawB) throw new AnalyticsError("invalid_argument", `"${p.period_b}" is not a recognised period.`, "Use YYYY-MM-DD, YYYY-MM, YYYY-Qn or YYYY (for example 2026-05).");
  if (rawA && rawB) return { a: rawA, b: rawB, grain: s.grain, defaulted: false };
  // defaults use the latest COMPLETE periods (safeguard: never anchor on a partial edge period)
  let a = rawA;
  let ordA: number | null = null;
  if (!a) {
    const last = s.points[s.points.length - 1];
    if (!last) throw new AnalyticsError("insufficient_data", "There are no complete periods to compare.");
    a = last.period; ordA = last.ord;
  } else ordA = ordinalFromKey(a, s.grain);
  if (ordA === null) throw new AnalyticsError("invalid_argument", `"${a}" doesn't match the ${s.grain} grain of this analysis.`, `Use a ${s.grain} key such as ${s.points[s.points.length - 1]?.period ?? "2026-05"}, or pass both period_a and period_b.`);
  const back = compareTo === "year_ago" ? seasonLength(s.grain) || 1 : 1;
  return { a, b: periodKey(ordA - back, s.grain), grain: s.grain, defaulted: !rawA };
}

const PERIOD_PROPS = {
  period_a: { type: "string", description: "The period of interest, e.g. 2026-05, 2026-Q2, 2026 (default: the latest complete period)." },
  period_b: { type: "string", description: "The baseline period (default: the one before period_a, or a year earlier if compare_to=year_ago)." },
  compare_to: { type: "string", enum: ["previous", "year_ago"], description: "How to pick the baseline when period_b is omitted." },
} as const;

function contributorFacts(b: Builder, cmp: PeriodComparison, s: ToolSeries) {
  const bd = cmp.breakdown!;
  return bd.contributors.map((c) => {
    const df = b.fs.num(`${c.key}: change`, c.delta * s.scale, s.unit, { signed: true });
    const sf = c.shareOfChange !== null ? b.fs.num(`${c.key}: share of the net change`, c.shareOfChange, "percent") : null;
    const pf = c.pctChange !== null && Math.abs(c.b) > 0 ? b.fs.num(`${c.key}: % change`, c.pctChange, "percent", { signed: true }) : null;
    return { key: c.key, isBlank: c.isBlank, a: c.a * s.scale, b: c.b * s.scale, delta: c.delta * s.scale, deltaDisplay: df.display, pctChange: c.pctChange, pctChangeDisplay: pf?.display ?? null, shareOfChange: c.shareOfChange, shareDisplay: sf?.display ?? null };
  });
}

const comparePeriodsTool: ToolDef = {
  name: "compare_periods",
  description: "Compare a metric between two periods (this month vs last month, Q2 vs Q1, 2026 vs 2025) with an optional breakdown showing which categories drove the change and whether it is concentrated or broad-based. Defaults to the latest two COMPLETE periods.",
  parameters: { properties: { ...SERIES_PROPS, ...PERIOD_PROPS, breakdown_dimension: { type: "string", description: "Category to attribute the change to (e.g. Product, Region)" }, top_n: { type: "integer", minimum: 1, maximum: 20, default: 6 } } },
  gate: needTime,
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const s = resolveSeries(sc.ctx, p);
    if (s.isMargin) throw new AnalyticsError("invalid_argument", "For margin, use volume_vs_margin, which decomposes profit changes into volume and margin effects.");
    const per = resolvePeriods(sc.ctx, s, p);
    const caps = sc.ctx.profile.capabilities;
    const params = { metric: s.metric, agg: s.agg, period_a: per.a, period_b: per.b, breakdown_dimension: p.breakdown_dimension ?? null, ...(p.filters ? { filters: p.filters } : {}) };
    const b = new Builder("compare_periods", sc.ctx, params, sc.warnings);
    let dimName: string | undefined;
    if (p.breakdown_dimension) {
      dimName = resolveDimension(sc.ctx, p.breakdown_dimension as string).name;
    }
    const m = { column: s.metric ?? undefined };
    const cmp = comparePeriods(sc.ctx.frame, sc.ctx.rows, {
      dateColumn: caps.eventDate!, metric: m.column, agg: s.agg === "distinct_count" ? "distinct_count" : s.agg, grain: per.grain, periodA: per.a, periodB: per.b,
      breakdownDimension: dimName, topN: clampInt(p.top_n, 1, 20, 6),
    }, { minDay: sc.ctx.profile.calendar!.minDay, maxDay: sc.ctx.profile.calendar!.maxDay });
    for (const w of cmp.warnings) b.caveat(w);
    for (const n of s.notes) b.caveat(n);
    if (per.defaulted) b.caveat("No periods were specified, so the latest complete period was compared with the one before it.");
    if (cmp.a.value === null || cmp.b.value === null) throw new AnalyticsError("no_matching_rows", `One of the periods has no rows (${cmp.a.value === null ? per.a : per.b}).`, `Complete periods available: ${s.points.slice(0, 3).map((x) => x.period).join(", ")} … ${s.points.slice(-3).map((x) => x.period).join(", ")}`);
    const med = median(s.points.map((x) => Math.abs(x.value)));
    const va = cmp.a.value * s.scale, vb = cmp.b.value * s.scale;
    const pct = pctGuard(cmp.a.value, cmp.b.value, med > 0 ? med : 0);
    const fa = b.fs.num(`${per.a}: ${s.label}`, va, s.unit), fb = b.fs.num(`${per.b}: ${s.label}`, vb, s.unit);
    const fd = b.fs.num("Change", va - vb, s.unit, { signed: true });
    const fp = pct !== null ? b.fs.num("Percent change", pct, "percent", { signed: true }) : null;
    if (pct === null && Math.abs(cmp.b.value) > 0) b.caveat("The baseline period is unusually small, so a percentage change would be misleading; the absolute change is reported instead.");
    const contributors = cmp.breakdown ? contributorFacts(b, cmp, s) : undefined;
    let summary = `${s.label}: ${per.a} was ${fa.display} versus ${fb.display} in ${per.b}, a change of ${fd.display}${fp ? ` (${fp.display})` : ""}.`;
    if (cmp.breakdown && contributors?.length && cmp.breakdown.pattern !== "none") {
      const top = contributors[0]!;
      summary += ` By ${cmp.breakdown.dimension}: ${cmp.breakdown.patternExplanation} The largest contributor is ${top.key} (${top.deltaDisplay}${top.shareDisplay ? `, ${top.shareDisplay} of the net change` : ""}).`;
    }
    const chart: ChartSpec | undefined = contributors?.length ? { kind: "bar", title: `Change in ${s.label} by ${cmp.breakdown!.dimension}`, unit: s.unit, currency: ctx.fmt.currency, horizontal: true, categories: contributors.map((c) => c.key), values: contributors.map((c) => c.delta) } : undefined;
    return b.done(jsonSafe({ metric: s.metric, agg: s.agg, a: { period: per.a, value: va, rows: cmp.a.n, partial: cmp.a.partial }, b: { period: per.b, value: vb, rows: cmp.b.n, partial: cmp.b.partial }, change: va - vb, pctChange: pct, direction: cmp.direction, breakdown: cmp.breakdown ? { dimension: cmp.breakdown.dimension, pattern: cmp.breakdown.pattern, explanation: cmp.breakdown.patternExplanation, groupsCompared: cmp.breakdown.groupsCompared, contributors } : null }), {
      summary, method: `${s.agg.toUpperCase()} in each period from civil dates; the breakdown attributes the net change to each category (a category's delta ÷ the net change).`, chart,
    });
  },
};

/* -------------------------------- explain_change ------------------------------ */

const explainChange: ToolDef = {
  name: "explain_change",
  description: "Why did a metric change between two periods? Tries every sensible breakdown (product, region, channel, …), reports which categories drove the change and whether it was concentrated or broad-based, and for revenue/profit splits the profit change into volume and margin effects. Defaults to the latest two complete periods.",
  parameters: { properties: { metric: SERIES_PROPS.metric, ...PERIOD_PROPS, ...COMMON_PROPS } },
  gate: needTime,
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const s = resolveSeries(sc.ctx, { ...p, agg: undefined });
    if (s.isMargin || !s.additive) throw new AnalyticsError("invalid_argument", "explain_change works on totals and counts (for example revenue or profit).", "Use compare_periods for averages, or volume_vs_margin for margin effects.");
    const per = resolvePeriods(sc.ctx, s, p);
    const b = new Builder("explain_change", sc.ctx, { metric: s.metric, period_a: per.a, period_b: per.b }, sc.warnings);
    const caps = sc.ctx.profile.capabilities;
    const range = { minDay: sc.ctx.profile.calendar!.minDay, maxDay: sc.ctx.profile.calendar!.maxDay };
    const results: { dimension: string; pattern: string; explanation: string; top: { key: string; delta: number; deltaDisplay: string; shareDisplay: string | null }[] }[] = [];
    let headline: PeriodComparison | null = null;
    let best: { cmp: PeriodComparison; rank: number } | null = null;
    for (const dim of candidateDimensions(sc.ctx, 5)) {
      try {
        const cmp = comparePeriods(sc.ctx.frame, sc.ctx.rows, { dateColumn: caps.eventDate!, metric: s.metric ?? undefined, agg: s.agg === "sum" ? "sum" : "count", grain: per.grain, periodA: per.a, periodB: per.b, breakdownDimension: dim.name, topN: 4 }, range);
        headline = headline ?? cmp;
        if (!cmp.breakdown) continue;
        const contributors = contributorFacts(b, cmp, s);
        results.push({ dimension: dim.name, pattern: cmp.breakdown.pattern, explanation: cmp.breakdown.patternExplanation, top: contributors.slice(0, 3).map((c) => ({ key: c.key, delta: c.delta, deltaDisplay: c.deltaDisplay, shareDisplay: c.shareDisplay })) });
        const rank = ({ concentrated: 3, "broad-based": 2, mixed: 1, none: 0 }[cmp.breakdown.pattern]) * 1000 + (cmp.breakdown.topContributorsShare ?? 0);
        if (!best || rank > best.rank) best = { cmp, rank };
      } catch (e) { if (!(e instanceof AnalyticsError)) throw e; }
    }
    if (!headline || headline.a.value === null || headline.b.value === null) throw new AnalyticsError("no_matching_rows", "One of the periods has no rows.");
    for (const w of headline.warnings) b.caveat(w);
    const va = headline.a.value * s.scale, vb = headline.b.value * s.scale;
    const med = median(s.points.map((x) => Math.abs(x.value)));
    const pct = pctGuard(headline.a.value, headline.b.value, med);
    const fa = b.fs.num(`${per.a}: ${s.label}`, va, s.unit), fb = b.fs.num(`${per.b}: ${s.label}`, vb, s.unit), fd = b.fs.num("Change", va - vb, s.unit, { signed: true });
    const fp = pct !== null ? b.fs.num("Percent change", pct, "percent", { signed: true }) : null;
    let summary = `${s.label} was ${fa.display} in ${per.a} versus ${fb.display} in ${per.b} (${fd.display}${fp ? `, ${fp.display}` : ""}).`;
    if (best?.cmp.breakdown) {
      const bd = best.cmp.breakdown, top = results.find((r) => r.dimension === bd.dimension)!.top[0];
      summary += ` The clearest driver is ${bd.dimension}: ${bd.patternExplanation}${top ? ` ${top.key} moved ${top.deltaDisplay}${top.shareDisplay ? ` (${top.shareDisplay} of the net change)` : ""}.` : ""}`;
    }
    let bridge: unknown = null;
    if (caps.margin && caps.revenue && caps.profit && s.metric && (s.metric === caps.revenue || s.metric === caps.profit)) {
      try {
        const r = seriesFor(sc.ctx, { metric: caps.revenue, agg: "sum" }), pr = seriesFor(sc.ctx, { metric: caps.profit, agg: "sum" });
        const rA = r.series.points.find((x) => x.period === per.a), rB = r.series.points.find((x) => x.period === per.b), pA = pr.series.points.find((x) => x.period === per.a), pB = pr.series.points.find((x) => x.period === per.b);
        if (rA && rB && pA && pB) {
          const v = volumeVsMargin(rA.value, pA.value, rB.value, pB.value);
          const sp = metricSpec(sc.ctx, caps.profit);
          if (v.volumeEffect !== null && v.marginEffect !== null) {
            const ve = b.fs.num("Volume effect on profit", v.volumeEffect * sp.scale, sp.unit, { signed: true }), me = b.fs.num("Margin effect on profit", v.marginEffect * sp.scale, sp.unit, { signed: true });
            summary += ` Profit change splits into a volume effect of ${ve.display} and a margin effect of ${me.display}.`;
            bridge = { volumeEffect: v.volumeEffect * sp.scale, marginEffect: v.marginEffect * sp.scale, marginChangePts: v.marginChangePts };
          }
        }
      } catch (e) { if (!(e instanceof AnalyticsError)) throw e; }
    }
    if (per.defaulted) b.caveat("No periods were specified, so the latest complete period was compared with the one before it.");
    for (const n of s.notes) b.caveat(n);
    return b.done(jsonSafe({ metric: s.metric, a: { period: per.a, value: va }, b: { period: per.b, value: vb }, change: va - vb, pctChange: pct, breakdowns: results, bridge }), {
      summary, method: "Each category's change is its value in period A minus period B; the pattern is concentrated when one or two categories explain most of the net change, broad-based when most move the same way.",
    });
  },
};

/* ---------------------------------- trend ------------------------------------ */

const trendTool: ToolDef = {
  name: "trend",
  description: "Is a metric trending up, down or flat over time? Fits a trend on complete periods only and reports the fitted change, per-period slope, statistical support and whether the pace is accelerating. Says plainly when there is no statistically supported trend.",
  parameters: { properties: SERIES_PROPS },
  gate: needTime,
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const s = resolveSeries(sc.ctx, p);
    const b = new Builder("trend", sc.ctx, { metric: s.metric, grain: s.grain, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    for (const n of s.notes) b.caveat(n);
    const pts = contiguous(s.points, s.grain, s.additive);
    if (!pts) throw new AnalyticsError("insufficient_data", `The ${s.label} series has too many missing ${s.grain}s to fit a trend reliably.`);
    const t = trendAnalysis(pts);
    if (!t) throw new AnalyticsError("insufficient_data", `Only ${pts.length} complete ${s.grain}s are available; at least 4 are needed to assess a trend.`);
    const n = b.fs.num("Complete periods analysed", t.n, "count");
    const first = b.fs.text("First complete period", pts[0]!.period, "date"), last = b.fs.text("Last complete period", pts[pts.length - 1]!.period, "date");
    const pf = b.fs.num("Trend significance (p-value)", t.slopeP, "number", { decimals: 3 });
    let summary: string;
    if (t.significant && t.fittedChangePct !== null) {
      const fc = b.fs.num("Fitted change over the period", t.fittedChangePct, "percent", { signed: true });
      const per = b.fs.num(`Trend per ${s.grain}, % of average level`, t.slopePctOfMean, "percent", { signed: true });
      summary = `${s.label} is ${t.direction}: the fitted trend changes ${fc.display} across ${n.display} complete ${s.grain}s (${first.display} to ${last.display}), about ${per.display} of its average level per ${s.grain} (p = ${pf.display}).`;
    } else {
      summary = `There is no statistically supported trend in ${s.label} across ${n.display} complete ${s.grain}s (${first.display} to ${last.display}): p = ${pf.display}.`;
    }
    const ep = t.endpointChangePct !== null ? b.fs.num("First-to-last change (endpoints)", t.endpointChangePct, "percent", { signed: true }) : null;
    if (ep) summary += ` Comparing only the first and last period gives ${ep.display}, which is noisier than the fitted trend.`;
    if (t.acceleration && t.acceleration.kind !== "steady" && t.significant) summary += ` The pace is ${t.acceleration.kind}.`;
    const r2 = b.fs.num("R²", t.r2, "number", { decimals: 2 });
    const vol = b.fs.num("Volatility (CV)", t.volatilityCV, "number", { decimals: 2 });
    const reg = linreg(pts.map((x) => x.value));
    const chart: ChartSpec = { kind: "line", title: `${s.label} by ${s.grain}`, unit: s.unit, currency: ctx.fmt.currency, x: pts.map((x) => x.period), series: [{ name: s.label, values: pts.map((x) => x.value * s.scale) }, { name: "Trend", values: reg.fit.map((v) => v * s.scale) }] };
    return b.done(jsonSafe({ metric: s.metric, grain: s.grain, direction: t.direction, significant: t.significant, fittedChangePct: t.fittedChangePct, slopePctOfMean: t.slopePctOfMean, p: t.slopeP, r2: t.r2, tau: t.tau, volatilityCV: t.volatilityCV, acceleration: t.acceleration?.kind ?? null, periods: t.n, r2Display: r2.display, volatilityDisplay: vol.display }), {
      summary, method: "OLS line over complete periods; a trend is reported only if the slope test (p < 0.05), a Mann–Kendall rank test and a minimum practical slope all agree.", chart,
    });
  },
};

const anomaliesTool: ToolDef = {
  name: "anomalies",
  description: "Unusual periods in a metric: spikes or drops relative to the trend, scored with a robust (median/MAD) z-score. Growth itself is not flagged.",
  parameters: { properties: SERIES_PROPS },
  gate: needTime,
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const s = resolveSeries(sc.ctx, p);
    const b = new Builder("anomalies", sc.ctx, { metric: s.metric, grain: s.grain, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    for (const n of s.notes) b.caveat(n);
    const pts = contiguous(s.points, s.grain, s.additive);
    if (!pts || pts.length < 8) throw new AnalyticsError("insufficient_data", `At least 8 complete ${s.grain}s with no gaps are needed to look for unusual periods; ${pts?.length ?? s.points.length} are available.`);
    const an = detectSeriesAnomalies(pts).slice(0, 6);
    const items = an.map((a) => {
      const v = b.fs.num(`${a.point.period}: ${s.label}`, a.point.value * s.scale, s.unit), e = b.fs.num(`${a.point.period}: expected`, a.expected * s.scale, s.unit);
      const dev = a.deviationPct !== null ? b.fs.num(`${a.point.period}: deviation from expected`, a.deviationPct, "percent", { signed: true }) : null;
      const z = b.fs.num(`${a.point.period}: robust z-score`, a.z, "number", { decimals: 1, signed: true });
      return { period: a.point.period, direction: a.direction, value: a.point.value * s.scale, display: v.display, expected: a.expected * s.scale, expectedDisplay: e.display, deviationPct: a.deviationPct, deviationDisplay: dev?.display ?? null, z: a.z, zDisplay: z.display };
    });
    const np = b.fs.num("Periods checked", pts.length, "count"), na = b.fs.num("Unusual periods found", items.length, "count");
    const summary = items.length
      ? `Of ${np.display} complete ${s.grain}s, ${na.display} stand out from the trend: ${items.map((i) => `${i.period} was ${i.display} versus ${i.expectedDisplay} expected${i.deviationDisplay ? ` (${i.deviationDisplay})` : ""}`).join("; ")}.`
      : `None of the ${np.display} complete ${s.grain}s is unusual relative to the trend.`;
    const idx = new Map(pts.map((pt, i) => [pt.period, i]));
    const chart: ChartSpec = {
      kind: "line", title: `${s.label} by ${s.grain}, unusual periods marked`, unit: s.unit, currency: ctx.fmt.currency,
      x: pts.map((x) => x.period), series: [{ name: s.label, values: pts.map((x) => x.value * s.scale) }],
      markers: items.map((i) => ({ index: idx.get(i.period)!, label: `${i.period}: ${i.direction}` })),
    };
    return b.done(jsonSafe({ metric: s.metric, grain: s.grain, periodsChecked: pts.length, anomalies: items }), { summary, method: "Detrend with a linear fit, then score each period's residual with median/MAD; flagged when the robust z-score is at least 3.2 in magnitude.", chart });
  },
};

const seasonalityTool: ToolDef = {
  name: "seasonality",
  description: "Does the metric have a seasonal pattern (by month of year or day of week)? Requires at least two full cycles of history; reports the peak and trough and whether the pattern is statistically distinguishable from noise.",
  parameters: { properties: SERIES_PROPS },
  gate: needSeason,
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const s = resolveSeries(sc.ctx, p);
    const b = new Builder("seasonality", sc.ctx, { metric: s.metric, grain: s.grain, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    for (const n of s.notes) b.caveat(n);
    const pts = contiguous(s.points, s.grain, s.additive);
    if (!pts) throw new AnalyticsError("insufficient_data", "The series has missing periods, so seasonality cannot be estimated reliably.");
    const r = seasonalityAnalysis(pts, s.grain);
    if (!r.ok) throw new AnalyticsError("insufficient_data", r.reason ?? "Seasonality could not be estimated.");
    const cyc = b.fs.num("Full cycles observed", r.fullCycles, "count"), pf = b.fs.num("Significance (p-value)", r.p ?? 1, "number", { decimals: 3 });
    const hi = b.fs.num("Peak vs average", r.peak!.pctAboveAverage, "percent"), lo = b.fs.num("Trough vs average", r.trough!.pctBelowAverage, "percent");
    const summary = r.significant
      ? `${s.label} shows a ${r.cycle === "month-of-year" ? "seasonal" : "weekly"} pattern over ${cyc.display} full cycles: strongest in ${r.peak!.label} (${hi.display} above average) and weakest in ${r.trough!.label} (${lo.display} below), p = ${pf.display}.`
      : `No statistically clear seasonal pattern in ${s.label} across ${cyc.display} full cycles (p = ${pf.display}); the apparent peak in ${r.peak!.label} and trough in ${r.trough!.label} could be noise.`;
    const chart: ChartSpec = { kind: "bar", title: `${s.label}: seasonal index`, unit: "ratio", categories: r.indices.map((x) => x.label), values: r.indices.map((x) => x.index) };
    return b.done(jsonSafe({ metric: s.metric, cycle: r.cycle, significant: r.significant, p: r.p, peak: r.peak, trough: r.trough, indices: r.indices, fullCycles: r.fullCycles }), { summary, method: "Ratio to a centred moving average, averaged by calendar position and tested with a one-way ANOVA.", chart });
  },
};

const forecastTool: ToolDef = {
  name: "forecast",
  description: "Forecast a metric for the next few periods with an uncertainty range. Chooses the model by backtesting on recent history and refuses when there is too little history, gaps that cannot be filled honestly, or an erratic series. Always states assumptions and limitations.",
  parameters: { properties: { ...SERIES_PROPS, horizon: { type: "integer", minimum: 1, maximum: 12, default: 3, description: "Number of future periods" } } },
  gate: needForecast,
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const s = resolveSeries(sc.ctx, p);
    const horizon = clampInt(p.horizon, 1, 12, 3);
    const b = new Builder("forecast", sc.ctx, { metric: s.metric, horizon, grain: s.grain, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    for (const n of s.notes) b.caveat(n);
    const f = forecast(s.points, s.grain, horizon, { fillGapsWithZero: s.additive && !s.isMargin, clampAtZero: s.unit !== "percent" });
    if (!f.ok || !f.model) throw new AnalyticsError("insufficient_data", f.reason ?? "A reliable forecast could not be produced.");
    const nar = forecastNarrative(f, b.fs);
    const pts = f.points.map((pt) => {
      const v = b.fs.num(`${pt.period}: forecast`, pt.value * s.scale, s.unit), lo = b.fs.num(`${pt.period}: lower bound`, pt.lo * s.scale, s.unit), hi = b.fs.num(`${pt.period}: upper bound`, pt.hi * s.scale, s.unit);
      return { period: pt.period, value: pt.value * s.scale, display: v.display, lo: pt.lo * s.scale, loDisplay: lo.display, hi: pt.hi * s.scale, hiDisplay: hi.display };
    });
    for (const l of nar.limitations) b.caveat(l);
    b.caveat(nar.intervalNote);
    const tail = s.points.slice(-18);
    const chart: ChartSpec = {
      kind: "line", title: `${s.label}: history and forecast`, unit: s.unit, currency: ctx.fmt.currency, x: [...tail.map((x) => x.period), ...pts.map((x) => x.period)],
      series: [{ name: s.label, values: [...tail.map((x) => x.value * s.scale), ...pts.map(() => null)] }, { name: "Forecast", style: "forecast", values: [...tail.map((_, i) => (i === tail.length - 1 ? tail[i]!.value * s.scale : null)), ...pts.map((x) => x.value)], lo: [...tail.map(() => null), ...pts.map((x) => x.lo)], hi: [...tail.map(() => null), ...pts.map((x) => x.hi)] }],
    };
    const mape = f.backtest?.mape ?? null;
    const mf = mape !== null ? b.fs.num("Backtest error (MAPE)", mape, "percent") : null;
    const first = pts[0]!;
    return b.done(jsonSafe({ metric: s.metric, grain: s.grain, model: f.model.name, modelLabel: f.model.label, confidence: f.confidence, historyPeriods: f.historyPeriods, backtest: f.backtest, points: pts, assumptions: nar.assumptions, limitations: nar.limitations }), {
      summary: `Forecast for ${s.label}: ${pts.map((x) => `${x.period} ≈ ${x.display} (range ${x.loDisplay} to ${x.hiDisplay})`).join("; ")}. Model: ${f.model.label.toLowerCase()}; confidence ${f.confidence.toLowerCase()}${mf ? `, backtest error ${mf.display}` : ""}. It is an estimate, not a guarantee.`,
      method: `${f.model.label}, selected by rolling-origin backtest on recent periods.`, chart: first ? chart : undefined,
    });
  },
};

/* ------------------------------ volume vs margin ------------------------------ */

const volumeVsMarginTool: ToolDef = {
  name: "volume_vs_margin",
  description: "Why did profit change? Splits the profit change between two periods into a volume effect (revenue moved at the old margin) and a margin effect (the profit rate changed). Defaults to the latest two complete periods.",
  parameters: { properties: { ...PERIOD_PROPS, ...COMMON_PROPS } },
  gate: (ctx) => (ctx.profile.capabilities.margin && ctx.profile.capabilities.timeSeries ? null : (ctx.profile.capabilities.unavailable.margin ?? needTime(ctx))),
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const caps = sc.ctx.profile.capabilities;
    const rev = seriesFor(sc.ctx, { metric: caps.revenue!, agg: "sum" }), prof = seriesFor(sc.ctx, { metric: caps.profit!, agg: "sum" });
    const fake = { grain: rev.grain, points: rev.complete.points } as ToolSeries;
    const per = resolvePeriods(sc.ctx, fake, p);
    const b = new Builder("volume_vs_margin", sc.ctx, { period_a: per.a, period_b: per.b }, sc.warnings);
    const g = (bund: typeof rev, key: string) => bund.series.points.find((x) => x.period === key);
    const rA = g(rev, per.a), rB = g(rev, per.b), pA = g(prof, per.a), pB = g(prof, per.b);
    if (!rA || !rB || !pA || !pB) throw new AnalyticsError("no_matching_rows", "One of the periods has no rows.", `Complete periods: ${rev.complete.points.slice(-3).map((x) => x.period).join(", ")}`);
    const v = volumeVsMargin(rA.value, pA.value, rB.value, pB.value);
    const sr = metricSpec(sc.ctx, caps.revenue!), sp = metricSpec(sc.ctx, caps.profit!);
    if (v.volumeEffect === null || v.marginEffect === null || v.marginA === null || v.marginB === null) throw new AnalyticsError("insufficient_data", "Revenue is zero in one of the periods, so margin is undefined.");
    const f = (l: string, x: number, u: Unit, sign = false) => b.fs.num(l, x, u, { signed: sign });
    const ra = f(`${per.a}: ${caps.revenue}`, rA.value * sr.scale, sr.unit), rb = f(`${per.b}: ${caps.revenue}`, rB.value * sr.scale, sr.unit);
    const pa = f(`${per.a}: ${caps.profit}`, pA.value * sp.scale, sp.unit), pb = f(`${per.b}: ${caps.profit}`, pB.value * sp.scale, sp.unit);
    const ma = f(`${per.a}: margin`, v.marginA, "percent"), mb = f(`${per.b}: margin`, v.marginB, "percent");
    const ve = f("Volume effect", v.volumeEffect * sp.scale, sp.unit, true), me = f("Margin effect", v.marginEffect * sp.scale, sp.unit, true), pc = f("Profit change", v.profitChange * sp.scale, sp.unit, true);
    if (per.defaulted) b.caveat("No periods were specified, so the latest complete period was compared with the one before it.");
    for (const n of rev.complete.notes) b.caveat(n);
    return b.done(jsonSafe({ a: { period: per.a, revenue: rA.value * sr.scale, profit: pA.value * sp.scale, margin: v.marginA }, b: { period: per.b, revenue: rB.value * sr.scale, profit: pB.value * sp.scale, margin: v.marginB }, profitChange: v.profitChange * sp.scale, volumeEffect: v.volumeEffect * sp.scale, marginEffect: v.marginEffect * sp.scale, marginChangePts: v.marginChangePts }), {
      summary: `${caps.profit} went from ${pb.display} in ${per.b} to ${pa.display} in ${per.a} (${pc.display}); ${caps.revenue} went from ${rb.display} to ${ra.display}, and the margin from ${mb.display} to ${ma.display}. Volume effect: ${ve.display}; margin effect: ${me.display}.`,
      method: "ΔProfit = ΔRevenue × old margin (volume) + new revenue × Δmargin (rate). The two effects sum exactly to the change.",
    });
  },
};

export const TEMPORAL_TOOLS: ToolDef[] = [timeSeriesTool, comparePeriodsTool, explainChange, trendTool, anomaliesTool, seasonalityTool, forecastTool, volumeVsMarginTool];
