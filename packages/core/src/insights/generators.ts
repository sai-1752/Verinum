/**
 * Insight generators. Each one turns computed results into a candidate finding whose every
 * number was created through a FactSet (so it is verifiable) and which cites the tool + params
 * that reproduce it. Generators are guarded: a finding is only emitted when the statistics
 * support it (see the safeguard notes inline).
 */
import type { AnalysisContext, MetricSpec } from "../context";
import { aggregate, latestPair, marginSeries, metricSpec, seriesFor } from "../context";
import { FactSet } from "../facts";
import type { ChartSpec } from "../charts";
import { AnalyticsError } from "../analytics/errors";
import { groupBy } from "../analytics/groupby";
import { concentration, isMeaningfullyConcentrated } from "../analytics/concentration";
import { trendAnalysis } from "../analytics/trend";
import { detectSeriesAnomalies } from "../analytics/anomaly";
import { seasonalityAnalysis } from "../analytics/seasonality";
import { forecast } from "../analytics/forecast";
import { comparePeriods, type PeriodComparison } from "../analytics/compare";
import { correlationPairs } from "../analytics/correlation";
import { profitabilityAnalysis, volumeVsMargin } from "../analytics/profitability";
import { customerAnalysis } from "../analytics/entities";
import { linreg, median, stdev } from "../stats";
import { periodKey, type Grain } from "../time";
import type { ColumnProfile } from "../types";
import type { SeriesPoint } from "../analytics/periods";
import { forecastNarrative } from "../narrative";
import { clamp01, CONFIDENCE_VALUE } from "./rank";
import type { Candidate, InsightCategory, InsightKind } from "./types";

/* --------------------------------- helpers --------------------------------- */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const insightId = (kind: InsightKind, ...parts: (string | number)[]) => `${kind}:${parts.map((p) => slug(String(p))).join(":")}`;

export function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const MEANING_RELEVANCE: Record<string, number> = { product: 1, customer: 0.95, region: 0.95, channel: 0.95, segment: 0.9, stage: 0.8 };
const dimRelevance = (c: ColumnProfile) => (c.meaning ? MEANING_RELEVANCE[c.meaning] ?? 0.7 : 0.7);
const metricRelevance = (ctx: AnalysisContext, column: string) => {
  const caps = ctx.profile.capabilities;
  if (column === caps.leadMetric) return 1;
  if (column === caps.revenue || column === caps.profit) return 0.95;
  return 0.6;
};
const completenessOf = (ctx: AnalysisContext, ...cols: (string | null | undefined)[]) => {
  let worst = 100;
  for (const name of cols) {
    if (!name) continue;
    const c = ctx.profile.columns.find((x) => x.name === name);
    if (c) worst = Math.min(worst, 100 - c.missingPct);
  }
  return clamp01(worst / 100);
};
const catOf = (k: InsightKind): InsightCategory =>
  k === "trend" || k === "period_change" || k === "anomaly" || k === "seasonality" ? "trend"
  : k === "profitability" || k === "loss_makers" || k === "margin_trend" || k === "volume_margin" ? "profitability"
  : k === "correlation" ? "relationship" : k === "customers" ? "customers" : k === "forecast" ? "forecast" : k === "quality" ? "quality" : "performance";

/** Candidate dimensions for breakdowns, ordered by business relevance. */
export function candidateDimensions(ctx: AnalysisContext, max = 5): ColumnProfile[] {
  const order = ["product", "region", "channel", "segment", "customer", "stage"];
  const dims = ctx.profile.columns.filter((c) => c.chartDimension && (c.role === "dimension") && c.analyzable && !c.subtypes.includes("calendar_part"));
  return [...dims].sort((a, b) => {
    const ia = a.meaning ? order.indexOf(a.meaning) : 99, ib = b.meaning ? order.indexOf(b.meaning) : 99;
    return (ia < 0 ? 98 : ia) - (ib < 0 ? 98 : ib) || a.index - b.index;
  }).slice(0, max);
}

function leadOf(ctx: AnalysisContext): MetricSpec | null {
  const l = ctx.profile.capabilities.leadMetric;
  return l ? metricSpec(ctx, l) : null;
}
const lbl = (m: MetricSpec | null) => (m ? m.column : "records");

/** Fills missing periods with zero for additive series when few enough; null when the series cannot be made contiguous. */
export function contiguous(points: SeriesPoint[], grain: Grain, fillZero: boolean): SeriesPoint[] | null {
  if (points.length < 2) return points;
  const first = points[0]!.ord, last = points[points.length - 1]!.ord;
  const span = last - first + 1;
  if (span === points.length) return points;
  if (!fillZero || (span - points.length) / span > 0.2) return null;
  const by = new Map(points.map((p) => [p.ord, p]));
  const out: SeriesPoint[] = [];
  for (let o = first; o <= last; o++) out.push(by.get(o) ?? { ord: o, period: periodKey(o, grain), startDay: 0, endDay: 0, n: 0, value: 0 });
  return out;
}

function seriesChart(title: string, pts: SeriesPoint[], spec: MetricSpec | null, ctx: AnalysisContext, extra: Partial<Extract<ChartSpec, { kind: "line" }>> = {}, fit?: number[]): ChartSpec {
  const sc = spec?.scale ?? 1;
  const series: Extract<ChartSpec, { kind: "line" }>["series"] = [{ name: spec ? spec.column : "Rows", values: pts.map((p) => p.value * sc) }];
  if (fit) series.push({ name: "Trend", values: fit.map((v) => v * sc) });
  return { kind: "line", title, unit: spec ? spec.unit : "count", currency: ctx.fmt.currency, x: pts.map((p) => p.period), series, ...extra };
}

/* ---------------------------- leader & concentration ------------------------ */

export function groupInsights(ctx: AnalysisContext, dim: ColumnProfile): Candidate[] {
  const lead = leadOf(ctx);
  const additive = !!lead && lead.additive;
  const metric = additive ? lead!.column : undefined;
  const g = groupBy(ctx.frame, ctx.rows, { dimension: dim.name, metric, agg: additive ? "sum" : "count" });
  const real = g.groups.filter((x) => !x.isBlank);
  const total = real.reduce((s, x) => s + Math.max(0, x.value), 0);
  const k = real.length;
  if (k < 2 || total <= 0) return [];
  const label = lbl(additive ? lead : null);
  const unit = additive ? lead!.unit : "count";
  const shareOf = (v: number) => (Math.max(0, v) / total) * 100;
  const blankShare = g.groups.find((x) => x.isBlank) ? (g.groups.find((x) => x.isBlank)!.value / (total + g.groups.find((x) => x.isBlank)!.value)) * 100 : 0;
  const caveats: string[] = [];
  const cf = new FactSet(ctx.fmt, "c");
  if (blankShare >= 2) caveats.push(`${cf.num("Blank share", blankShare, "percent").display} of ${label} has no ${dim.name} value and is excluded from this ranking.`);
  const values = real.map((x) => x.value);
  const conc = concentration(values, 3);
  const comp = completenessOf(ctx, dim.name, additive ? lead!.column : null);
  const rel = dimRelevance(dim) * (additive ? metricRelevance(ctx, lead!.column) : 0.6);
  const top = real.slice(0, Math.min(8, k));
  const chart: ChartSpec = {
    kind: "bar", title: `${label} by ${dim.name}`, unit, currency: ctx.fmt.currency, horizontal: true,
    categories: top.map((x) => x.key), values: top.map((x) => x.value * (additive ? lead!.scale : 1)),
    annotations: top.map((x) => `${shareOf(x.value).toFixed(1)}%`),
  };
  const evidence = { tool: "group_by", params: { dimension: dim.name, metric: metric ?? null, agg: additive ? "sum" : "count", limit: 5 } };
  const followUps = [`How has ${label} by ${dim.name} changed over time?`, `What are the top 5 ${dim.name} values by ${label}?`];
  const out: Candidate[] = [];

  if (isMeaningfullyConcentrated(conc)) {
    const fs = new FactSet(ctx.fmt, "f");
    const names = real.slice(0, conc.topN).map((x) => x.key);
    const n = fs.num(`Top groups counted`, conc.topN, "count");
    const share = fs.num(`Share held by top ${conc.topN} ${dim.name}`, conc.topShare, "percent");
    const base = fs.num("Share under an even split", conc.baseline, "percent");
    const mult = fs.num("Multiple of an even split", conc.multiple, "ratio", { decimals: 1 });
    const kk = fs.num(`Distinct ${dim.name} values`, k, "count");
    out.push({
      id: insightId("concentration", dim.name, label), kind: "concentration", category: catOf("concentration"), subject: dim.name,
      title: `${label} is concentrated in a few ${dim.name} values`,
      summary: `The top ${n.display} ${dim.name} values (${joinList(names)}) account for ${share.display} of ${label}, versus ${base.display} if all ${kk.display} were equal — ${mult.display} an even split.`,
      detail: [],
      facts: [...fs.facts, ...cf.facts], columns: [dim.name, ...(metric ? [metric] : [])],
      factors: { magnitude: clamp01((conc.multiple - 1) / 1.5), relevance: rel, significance: clamp01(conc.normalized * 3), novelty: 1, confidence: k >= 8 ? CONFIDENCE_VALUE.high : CONFIDENCE_VALUE.medium, completeness: comp },
      confidence: k >= 8 ? "high" : "medium", caveats,
      method: "Groups are summed and sorted and the top N share is compared with an even split. Concentration is only reported with at least 5 groups, a top share of at least 1.4× an even split, and an uneven distribution overall (Herfindahl gate).",
      evidence: { ...evidence, params: { ...evidence.params, limit: conc.topN } }, followUps, chart,
    });
    return out;
  }

  const first = real[0]!, second = real[1]!;
  const s1 = shareOf(first.value), s2 = shareOf(second.value);
  const multiple1 = s1 / (100 / k);
  if (multiple1 >= 1.3 && first.value >= second.value * 1.15 && first.value > 0) {
    const fs = new FactSet(ctx.fmt, "f");
    const v = fs.num(`${first.key} ${label}`, first.value * (additive ? lead!.scale : 1), unit);
    const sh = fs.num(`${first.key} share`, s1, "percent");
    const sh2 = fs.num(`${second.key} share`, s2, "percent");
    const mult = fs.num("Multiple of an even split", multiple1, "ratio", { decimals: 1 });
    const kk = fs.num(`Distinct ${dim.name} values`, k, "count");
    out.push({
      id: insightId("leader", dim.name, label), kind: "leader", category: catOf("leader"), subject: dim.name,
      title: `${first.key} is the top ${dim.name} by ${label}`,
      summary: `${first.key} accounts for ${sh.display} of ${label} (${v.display}), ahead of ${second.key} at ${sh2.display} — ${mult.display} an even split across ${kk.display} ${dim.name} values.`,
      detail: [], facts: [...fs.facts, ...cf.facts], columns: [dim.name, ...(metric ? [metric] : [])],
      factors: { magnitude: clamp01((multiple1 - 1) / 1.5), relevance: rel, significance: 0.6, novelty: 1, confidence: CONFIDENCE_VALUE.high, completeness: comp },
      confidence: "high", caveats, method: "Groups are aggregated and ranked; the leader must be at least 1.3× an even split and 15% above the runner-up.",
      evidence, followUps, chart,
    });
  }
  return out;
}

/* ---------------------------------- trends --------------------------------- */

export function trendInsights(ctx: AnalysisContext): Candidate[] {
  const lead = leadOf(ctx);
  if (!ctx.profile.capabilities.timeSeries) return [];
  const b = seriesFor(ctx, { metric: lead?.column, agg: lead ? lead.agg : "count" });
  const pts = contiguous(b.complete.points, b.grain, !lead || lead.additive);
  if (!pts) return [];
  const t = trendAnalysis(pts);
  if (!t || !t.significant || t.fittedChangePct === null) return [];
  const label = lbl(lead);
  const rising = t.direction === "rising";
  const fs = new FactSet(ctx.fmt, "f");
  const fitted = fs.num("Fitted change over the period", Math.abs(t.fittedChangePct), "percent");
  const per = fs.num(`Trend per ${b.grain}, % of average level`, Math.abs(t.slopePctOfMean), "percent");
  const n = fs.num("Complete periods analysed", t.n, "count");
  const first = fs.text("First complete period", pts[0]!.period, "date"), last = fs.text("Last complete period", pts[pts.length - 1]!.period, "date");
  const detail: string[] = [];
  if (t.acceleration && t.acceleration.kind !== "steady") detail.push(`The pace is ${t.acceleration.kind}: the slope in the second half of the period differs from the first half.`);
  const ep = t.endpointChangePct !== null ? fs.num("First-to-last change (endpoints)", t.endpointChangePct, "percent", { signed: true }) : null;
  if (ep) detail.push(`Comparing only the first and last period gives ${ep.display}; the fitted trend line is used for the headline because a comparison of end points alone is noisy.`);
  const reg = linreg(pts.map((p) => p.value));
  const conf = t.n >= 12 && t.r2 >= 0.3 ? "high" : t.n >= 8 ? "medium" : "low";
  return [{
    id: insightId("trend", label), kind: "trend", category: catOf("trend"), subject: label,
    title: `${label} is ${rising ? "trending up" : "trending down"}`,
    summary: `${label} ${rising ? "rose" : "fell"} ${fitted.display} on the fitted trend line across ${n.display} complete ${b.grain}s (${first.display} to ${last.display}), roughly ${per.display} of its average level each ${b.grain}.`,
    detail, facts: fs.facts, columns: lead ? [lead.column] : [],
    factors: { magnitude: clamp01(Math.abs(t.fittedChangePct) / 60), relevance: lead ? metricRelevance(ctx, lead.column) : 0.6, significance: clamp01(-Math.log10(Math.max(1e-12, t.slopeP)) / 4), novelty: 1, confidence: CONFIDENCE_VALUE[conf], completeness: completenessOf(ctx, lead?.column) },
    confidence: conf, caveats: [...b.complete.notes, ...(t.r2 < 0.3 ? ["The trend line explains little of the period-to-period variation."] : [])],
    method: "Ordinary least-squares line over complete periods, required to pass a slope significance test (p < 0.05), a Mann–Kendall rank test and a minimum practical slope.",
    evidence: { tool: "trend", params: { metric: lead?.column ?? null, grain: b.grain } },
    followUps: [`What is driving the change in ${label}?`, `Forecast ${label} for the next 3 ${b.grain}s.`],
    chart: seriesChart(`${label} by ${b.grain}`, pts, lead, ctx, {}, reg.fit),
  }];
}

/** Latest complete period versus the one before, with a contribution-to-change breakdown. */
export function periodChangeInsights(ctx: AnalysisContext): Candidate[] {
  const lead = leadOf(ctx);
  const caps = ctx.profile.capabilities;
  if (!caps.timeSeries || !caps.eventDate || !ctx.profile.calendar) return [];
  const b = seriesFor(ctx, { metric: lead?.column, agg: lead ? lead.agg : "count" });
  const pair = latestPair(b.complete.points);
  if (!pair) return [];
  const { current, previous } = pair;
  if (Math.abs(previous.value) < 1e-9) return [];
  const med = median(b.complete.points.map((p) => Math.abs(p.value)));
  if (Math.abs(previous.value) < 0.1 * med) return []; // base effect: a tiny prior period makes any % meaningless
  const pct = ((current.value - previous.value) / Math.abs(previous.value)) * 100;
  if (Math.abs(pct) < 5) return [];
  const diffs = b.complete.points.slice(1).map((p, i) => p.value - b.complete.points[i]!.value);
  const sd = stdev(diffs);
  const z = sd > 0 ? Math.abs(current.value - previous.value) / sd : 0;
  const label = lbl(lead);
  const up = pct > 0;
  const range = { minDay: ctx.profile.calendar.minDay, maxDay: ctx.profile.calendar.maxDay };

  let best: PeriodComparison | null = null;
  for (const dim of candidateDimensions(ctx, 4)) {
    if (lead && !lead.additive) break;
    try {
      const cmp = comparePeriods(ctx.frame, ctx.rows, { dateColumn: caps.eventDate, metric: lead?.column, agg: lead ? "sum" : "count", grain: b.grain, periodA: current.period, periodB: previous.period, breakdownDimension: dim.name, topN: 6 }, range);
      const rank = (c: PeriodComparison) => (c.breakdown ? ({ concentrated: 3, "broad-based": 2, mixed: 1, none: 0 }[c.breakdown.pattern] * 1000 + (c.breakdown.topContributorsShare ?? 0)) : -1);
      if (!best || rank(cmp) > rank(best)) best = cmp;
    } catch (e) { if (!(e instanceof AnalyticsError)) throw e; }
  }

  const fs = new FactSet(ctx.fmt, "f");
  const sc = lead?.scale ?? 1, unit = lead?.unit ?? "count";
  const pf = fs.num("Percent change", Math.abs(pct), "percent");
  const af = fs.num("Absolute change", Math.abs(current.value - previous.value) * sc, unit);
  const cv = fs.num(`${label} in ${current.period}`, current.value * sc, unit);
  const pv = fs.num(`${label} in ${previous.period}`, previous.value * sc, unit);
  const cur = fs.text("Current period", current.period, "date"), prev = fs.text("Previous period", previous.period, "date");
  let summary = `${label} ${up ? "rose" : "fell"} ${pf.display} from ${prev.display} (${pv.display}) to ${cur.display} (${cv.display}), a difference of ${af.display}.`;
  const detail: string[] = [];
  let dimName: string | null = null;
  if (best?.breakdown && best.breakdown.pattern !== "none") {
    const bd = best.breakdown;
    dimName = bd.dimension;
    const top = bd.contributors[0]!;
    if (bd.pattern === "concentrated" && top.shareOfChange !== null) {
      const s = fs.num(`${top.key} share of the change`, top.shareOfChange, "percent");
      summary += ` By ${bd.dimension}, the change is concentrated: ${top.key} accounts for ${s.display} of it.`;
    } else if (bd.pattern === "broad-based") {
      const same = fs.num("Groups moving the same way", bd.movedInSameDirection, "count"), all = fs.num("Groups compared", bd.groupsCompared, "count");
      summary += ` It is broad-based across ${bd.dimension}: ${same.display} of ${all.display} values moved in the same direction.`;
    } else {
      summary += ` By ${bd.dimension}, groups moved in different directions.`;
    }
    detail.push(bd.patternExplanation);
  }
  const conf = z >= 2 ? "high" : z >= 1 ? "medium" : "low";
  const chart = seriesChart(`${label} by ${b.grain}`, b.complete.points.slice(-18), lead, ctx);
  return [{
    id: insightId("period_change", label), kind: "period_change", category: catOf("period_change"), subject: label,
    title: `${label} ${up ? "increased" : "decreased"} in the latest complete ${b.grain}`,
    summary, detail, facts: fs.facts, columns: [...(lead ? [lead.column] : []), ...(dimName ? [dimName] : [])],
    factors: { magnitude: clamp01(Math.abs(pct) / 40), relevance: lead ? metricRelevance(ctx, lead.column) : 0.6, significance: clamp01(z / 3), novelty: 1, confidence: CONFIDENCE_VALUE[conf], completeness: completenessOf(ctx, lead?.column) },
    confidence: conf, caveats: [...b.complete.notes, ...(best?.warnings ?? [])],
    method: "Last two adjacent complete periods compared; a partial edge period is never used. Significance compares the change with the typical period-to-period movement.",
    evidence: { tool: "compare_periods", params: { metric: lead?.column ?? null, period_a: current.period, period_b: previous.period, breakdown_dimension: dimName } },
    followUps: [`Why did ${label} change in ${current.period}?`, `Which ${dimName ?? "segments"} drove the change?`], chart,
  }];
}

export function anomalyInsights(ctx: AnalysisContext): Candidate[] {
  const lead = leadOf(ctx);
  if (!ctx.profile.capabilities.timeSeries) return [];
  const b = seriesFor(ctx, { metric: lead?.column, agg: lead ? lead.agg : "count" });
  const pts = contiguous(b.complete.points, b.grain, !lead || lead.additive);
  if (!pts || pts.length < 8) return [];
  const an = detectSeriesAnomalies(pts).slice(0, 2);
  const label = lbl(lead), sc = lead?.scale ?? 1, unit = lead?.unit ?? "count";
  return an.map((a) => {
    const fs = new FactSet(ctx.fmt, "f");
    const v = fs.num(`${label} in ${a.point.period}`, a.point.value * sc, unit);
    const e = fs.num("Expected from the trend", a.expected * sc, unit);
    const per = fs.text("Period", a.point.period, "date");
    const dev = a.deviationPct !== null ? fs.num("Deviation from expected", Math.abs(a.deviationPct), "percent") : null;
    const spike = a.direction === "spike";
    const idx = pts.findIndex((p) => p.ord === a.point.ord);
    const zf = fs.num("Robust z-score", Math.abs(a.z), "number", { decimals: 1 });
    return {
      id: insightId("anomaly", label, a.point.period), kind: "anomaly" as const, category: catOf("anomaly"), subject: label,
      title: `${label} ${spike ? "spiked" : "dropped"} unusually in ${a.point.period}`,
      summary: `${label} in ${per.display} was ${v.display}, ${dev ? `${dev.display} ${spike ? "above" : "below"}` : spike ? "above" : "below"} the ${e.display} expected from the trend (robust z-score ${zf.display}).`,
      detail: [], facts: fs.facts, columns: lead ? [lead.column] : [],
      factors: { magnitude: clamp01(Math.abs(a.deviationPct ?? 0) / 60), relevance: lead ? metricRelevance(ctx, lead.column) : 0.6, significance: clamp01((Math.abs(a.z) - 3) / 3 + 0.4), novelty: 1, confidence: pts.length >= 12 ? CONFIDENCE_VALUE.high : CONFIDENCE_VALUE.medium, completeness: completenessOf(ctx, lead?.column) },
      confidence: (pts.length >= 12 ? "high" : "medium") as "high" | "medium", caveats: b.complete.notes,
      method: "The series is detrended with a linear fit and each period scored with a median/MAD robust z-score; only |z| ≥ 3.2 is flagged.",
      evidence: { tool: "anomalies", params: { metric: lead?.column ?? null, grain: b.grain } },
      followUps: [`What happened in ${a.point.period}?`],
      chart: seriesChart(`${label} by ${b.grain}`, pts, lead, ctx, { markers: [{ index: idx, label: spike ? "spike" : "drop" }] }),
    };
  });
}

export function seasonalityInsights(ctx: AnalysisContext): Candidate[] {
  const caps = ctx.profile.capabilities;
  if (!caps.seasonality) return [];
  const lead = leadOf(ctx);
  const b = seriesFor(ctx, { metric: lead?.column, agg: lead ? lead.agg : "count" });
  const pts = contiguous(b.complete.points, b.grain, !lead || lead.additive);
  if (!pts) return [];
  const s = seasonalityAnalysis(pts, b.grain);
  if (!s.ok || !s.significant || !s.peak || !s.trough || s.p === undefined) return [];
  const label = lbl(lead);
  const fs = new FactSet(ctx.fmt, "f");
  const hi = fs.num("Peak vs average", s.peak.pctAboveAverage, "percent"), lo = fs.num("Trough vs average", s.trough.pctBelowAverage, "percent");
  const cyc = fs.num("Full cycles observed", s.fullCycles, "count");
  return [{
    id: insightId("seasonality", label), kind: "seasonality", category: catOf("seasonality"), subject: label,
    title: `${label} follows a ${s.cycle === "month-of-year" ? "seasonal" : "weekly"} pattern`,
    summary: `${label} peaks in ${s.peak.label} (${hi.display} above average) and is weakest in ${s.trough.label} (${lo.display} below), observed over ${cyc.display} full cycles.`,
    detail: [], facts: fs.facts, columns: lead ? [lead.column] : [],
    factors: { magnitude: clamp01((s.spreadPct ?? 0) / 80), relevance: lead ? metricRelevance(ctx, lead.column) : 0.6, significance: clamp01(-Math.log10(Math.max(1e-12, s.p)) / 4), novelty: 1, confidence: s.fullCycles >= 3 ? CONFIDENCE_VALUE.high : CONFIDENCE_VALUE.medium, completeness: completenessOf(ctx, lead?.column) },
    confidence: s.fullCycles >= 3 ? "high" : "medium", caveats: [`Based on ${s.fullCycles} full cycles; the estimate improves with more history.`],
    method: "Ratio of each period to its centred moving average, grouped by calendar position and tested with a one-way ANOVA (p < 0.05) and a minimum spread.",
    evidence: { tool: "seasonality", params: { metric: lead?.column ?? null } },
    followUps: [`Is the ${s.peak.label} peak growing year over year?`],
    chart: { kind: "bar", title: `${label}: seasonal index`, unit: "ratio", categories: s.indices.map((x) => x.label), values: s.indices.map((x) => x.index), highlight: [s.indices.findIndex((x) => x.label === s.peak!.label)] },
  }];
}

/* ------------------------------- profitability ----------------------------- */

export function profitabilityInsights(ctx: AnalysisContext): Candidate[] {
  const caps = ctx.profile.capabilities;
  if (!caps.margin || !caps.revenue || !caps.profit) return [];
  const rev = metricSpec(ctx, caps.revenue), prof = metricSpec(ctx, caps.profit);
  if (!rev.additive || !prof.additive) return []; // additive-only profit insights (safeguard 10)
  const out: Candidate[] = [];
  const overallRev = aggregate(ctx, "sum", caps.revenue).value ?? 0;
  if (overallRev <= 0) return [];
  for (const dim of candidateDimensions(ctx, 4)) {
    let pa;
    try { pa = profitabilityAnalysis(ctx.frame, ctx.rows, { revenue: caps.revenue, profit: caps.profit, dimension: dim.name }); } catch (e) { if (e instanceof AnalyticsError) continue; throw e; }
    const overallMargin = pa.overall.margin;
    if (overallMargin === null) continue;
    const comp = completenessOf(ctx, caps.revenue, caps.profit, dim.name);
    const rel = dimRelevance(dim) * 0.95;
    const material = pa.groups.filter((g) => !g.isBlank);
    const lowRow = pa.highRevenueLowMargin[0];
    if (lowRow && lowRow.margin !== null) {
      const fs = new FactSet(ctx.fmt, "f");
      const m = fs.num(`${lowRow.key} margin`, lowRow.margin, "percent"), om = fs.num("Overall margin", overallMargin, "percent");
      const rs = fs.num(`${lowRow.key} share of ${caps.revenue}`, lowRow.revenueShare, "percent"), ps = fs.num(`${lowRow.key} share of ${caps.profit}`, lowRow.profitShare, "percent");
      const gap = overallMargin - lowRow.margin;
      out.push({
        id: insightId("profitability", dim.name, lowRow.key), kind: "profitability", category: catOf("profitability"), subject: dim.name,
        title: `${lowRow.key} brings in revenue but little profit`,
        summary: `${lowRow.key} generates ${rs.display} of ${caps.revenue} but only ${ps.display} of ${caps.profit}: its margin is ${m.display} against ${om.display} overall.`,
        detail: [], facts: fs.facts, columns: [dim.name, caps.revenue, caps.profit],
        factors: { magnitude: clamp01(gap / 25 + lowRow.shareGap / 40), relevance: rel, significance: 0.7, novelty: 1, confidence: CONFIDENCE_VALUE.high, completeness: comp },
        confidence: "high", caveats: [],
        method: "Margin = SUM(profit) ÷ SUM(revenue) per group (never an average of row margins). Flagged when a material group's margin is >5 points below overall and its revenue share exceeds its profit share by >3 points.",
        evidence: { tool: "profitability", params: { dimension: dim.name } },
        followUps: [`What is driving the low margin for ${lowRow.key}?`, `How has ${lowRow.key} margin changed over time?`],
        chart: { kind: "bar", title: `Margin % by ${dim.name}`, unit: "percent", categories: material.slice(0, 8).map((g) => g.key), values: material.slice(0, 8).map((g) => g.margin ?? 0), horizontal: true, highlight: [material.findIndex((g) => g.key === lowRow.key)].filter((i) => i >= 0 && i < 8) },
      });
    }
    const losers = pa.lossMakers.filter((g) => g.rows >= 3);
    if (losers.length) {
      const totalLoss = losers.reduce((s, g) => s + g.profit, 0);
      if (Math.abs(totalLoss) >= 0.005 * Math.abs(pa.overall.profit || 1)) {
        const fs = new FactSet(ctx.fmt, "f");
        const cnt = fs.num("Loss-making groups", losers.length, "count");
        const loss = fs.num("Combined loss", totalLoss * prof.scale, prof.unit);
        out.push({
          id: insightId("loss_makers", dim.name), kind: "loss_makers", category: catOf("loss_makers"), subject: dim.name,
          title: `Some ${dim.name} values lose money`,
          summary: `${cnt.display} ${dim.name} value${losers.length === 1 ? "" : "s"} (${joinList(losers.slice(0, 3).map((g) => g.key))}) have negative total ${caps.profit}, a combined ${loss.display}.`,
          detail: [], facts: fs.facts, columns: [dim.name, caps.profit],
          factors: { magnitude: clamp01(Math.abs(totalLoss) / Math.max(1, Math.abs(pa.overall.profit)) * 5), relevance: rel, significance: 0.8, novelty: 1, confidence: CONFIDENCE_VALUE.high, completeness: comp },
          confidence: "high", caveats: [], method: "Groups whose summed profit is below zero (at least 3 rows).",
          evidence: { tool: "profitability", params: { dimension: dim.name } },
          followUps: [`Why is ${losers[0]!.key} unprofitable?`],
        });
      }
    }
  }

  // margin trend from per-period SUM(profit)/SUM(revenue)
  if (caps.timeSeries) {
    try {
      const ms = marginSeries(ctx);
      if (!ms) throw new AnalyticsError("not_available", "no margin");
      const r = { grain: ms.grain, complete: { notes: ms.notes, points: ms.points } };
      const pts = ms.points;
      const t = trendAnalysis(contiguous(pts, r.grain, false) ?? []);
      if (t && t.significant && Math.abs(t.slope * (t.n - 1)) >= 2) {
        const fs = new FactSet(ctx.fmt, "f");
        const from = linreg(pts.map((x) => x.value)).fit[0]!, to = linreg(pts.map((x) => x.value)).fit[pts.length - 1]!;
        const a = fs.num("Fitted margin at start", from, "percent"), bb = fs.num("Fitted margin at end", to, "percent");
        const n = fs.num("Complete periods analysed", t.n, "count");
        const down = t.slope < 0;
        out.push({
          id: insightId("margin_trend", caps.profit), kind: "margin_trend", category: catOf("margin_trend"), subject: "margin",
          title: `Profit margin is ${down ? "eroding" : "improving"}`,
          summary: `The fitted profit margin moved from ${a.display} to ${bb.display} across ${n.display} complete ${r.grain}s.`,
          detail: [], facts: fs.facts, columns: [caps.revenue, caps.profit],
          factors: { magnitude: clamp01(Math.abs(to - from) / 12), relevance: 0.95, significance: clamp01(-Math.log10(Math.max(1e-12, t.slopeP)) / 4), novelty: 1, confidence: t.n >= 12 ? CONFIDENCE_VALUE.high : CONFIDENCE_VALUE.medium, completeness: completenessOf(ctx, caps.revenue, caps.profit) },
          confidence: t.n >= 12 ? "high" : "medium", caveats: r.complete.notes,
          method: "Per-period margin = SUM(profit) ÷ SUM(revenue); a linear trend over complete periods must pass slope and rank significance tests.",
          evidence: { tool: "trend", params: { metric: "margin", grain: r.grain } },
          followUps: ["What is driving the change in margin?"],
          chart: { kind: "line", title: "Profit margin by period", unit: "percent", x: pts.map((x) => x.period), series: [{ name: "Margin", values: pts.map((x) => x.value) }] },
        });
      }
    } catch (e) { if (!(e instanceof AnalyticsError)) throw e; }

    // volume vs margin over the last two complete periods
    try {
      const r = seriesFor(ctx, { metric: caps.revenue, agg: "sum" }), p = seriesFor(ctx, { metric: caps.profit, agg: "sum" });
      const rp = latestPair(r.complete.points), pp = latestPair(p.complete.points);
      if (rp && pp && rp.current.ord === pp.current.ord) {
        const v = volumeVsMargin(rp.current.value, pp.current.value, rp.previous.value, pp.previous.value);
        if (v.profitChangePct !== null && Math.abs(v.profitChangePct) >= 5 && v.marginChangePts !== null && Math.abs(v.marginChangePts) >= 1 && v.volumeEffect !== null && v.marginEffect !== null) {
          const fs = new FactSet(ctx.fmt, "f");
          const cur = fs.text("Current period", rp.current.period, "date"), prev = fs.text("Previous period", rp.previous.period, "date");
          const pc = fs.num("Profit change", v.profitChange * prof.scale, prof.unit, { signed: true });
          const ppc = fs.num("Profit change %", v.profitChangePct, "percent", { signed: true });
          const ve = fs.num("Volume effect", v.volumeEffect * prof.scale, prof.unit, { signed: true });
          const me = fs.num("Margin effect", v.marginEffect * prof.scale, prof.unit, { signed: true });
          const mm = fs.num("Margin change", v.marginChangePts, "percent", { signed: true, decimals: 1 });
          const rc = v.revenueChangePct !== null ? fs.num("Revenue change %", v.revenueChangePct, "percent", { signed: true }) : null;
          const diverge = rc && v.revenueChangePct !== null && Math.sign(v.revenueChangePct) !== Math.sign(v.profitChangePct);
          out.push({
            id: insightId("volume_margin", caps.profit), kind: "volume_margin", category: catOf("volume_margin"), subject: "profit-bridge",
            title: diverge ? `${caps.profit} moved opposite to ${caps.revenue}` : `What moved ${caps.profit} between ${prev.display} and ${cur.display}`,
            summary: `${caps.profit} changed ${pc.display} (${ppc.display}) from ${prev.display} to ${cur.display}${rc ? ` while ${caps.revenue} changed ${rc.display}` : ""}: volume contributed ${ve.display} and the margin shift (${mm.display} points) contributed ${me.display}.`,
            detail: [], facts: fs.facts, columns: [caps.revenue, caps.profit],
            factors: { magnitude: clamp01(Math.abs(v.profitChangePct) / 40 + (diverge ? 0.25 : 0)), relevance: 0.95, significance: 0.65, novelty: 1, confidence: CONFIDENCE_VALUE.medium, completeness: completenessOf(ctx, caps.revenue, caps.profit) },
            confidence: "medium", caveats: r.complete.notes,
            method: "ΔProfit = ΔRevenue × previous margin (volume) + current revenue × Δmargin (rate); the two effects sum exactly to the change.",
            evidence: { tool: "compare_periods", params: { metric: caps.profit, period_a: rp.current.period, period_b: rp.previous.period } },
            followUps: [`Which ${candidateDimensions(ctx, 1)[0]?.name ?? "segment"} drove the margin change?`],
          });
        }
      }
    } catch (e) { if (!(e instanceof AnalyticsError)) throw e; }
  }
  return out;
}

/* ---------------------------- relationships & the rest ---------------------- */

const VALUE_MEANINGS = new Set(["revenue", "cost", "profit"]);

/**
 * Pairs that co-move by construction, even when the arithmetic identity was not detected in the
 * rows (e.g. revenue = quantity × price × (1 − discount)). Reporting them as findings would be
 * the "tautological correlation" defect (safeguard 7).
 */
export function structuralCorrelationReason(ctx: AnalysisContext, a: string, b: string): string | null {
  const pa = ctx.profile.columns.find((c) => c.name === a), pb = ctx.profile.columns.find((c) => c.name === b);
  if (!pa || !pb) return null;
  const ma = pa.meaning ?? "", mb = pb.meaning ?? "";
  if ((ma === "quantity" && VALUE_MEANINGS.has(mb)) || (mb === "quantity" && VALUE_MEANINGS.has(ma))) {
    return `${ma === "quantity" ? a : b} is the volume that drives ${ma === "quantity" ? b : a} (value = units × price), so they rise together by construction.`;
  }
  if (VALUE_MEANINGS.has(ma) && VALUE_MEANINGS.has(mb)) return `${a} and ${b} are both money amounts that scale with volume, so their correlation is expected rather than informative.`;
  return null;
}

export function correlationInsights(ctx: AnalysisContext): Candidate[] {
  const cols = ctx.profile.capabilities.measures.slice(0, 10);
  if (cols.length < 2 || ctx.rowCount < 30) return [];
  const pairs = correlationPairs(ctx.frame, ctx.rows, cols, { relations: ctx.profile.relations });
  const good = pairs
    .filter((p) => !p.tautological && !structuralCorrelationReason(ctx, p.a, p.b) && Math.abs(p.r) >= 0.5 && p.p < 0.01 && p.n >= 30)
    .slice(0, 2);
  return good.map((p) => {
    const fs = new FactSet(ctx.fmt, "f");
    const r = fs.num("Pearson r", p.r, "number", { decimals: 2 }), n = fs.num("Paired observations", p.n, "count");
    const same = p.r > 0;
    return {
      id: insightId("correlation", p.a, p.b), kind: "correlation" as const, category: catOf("correlation"), subject: `${p.a}|${p.b}`,
      title: `${p.a} and ${p.b} move ${same ? "together" : "in opposite directions"}`,
      summary: `Across ${n.display} rows, ${p.a} and ${p.b} are ${same ? "positively" : "negatively"} correlated (r = ${r.display}).`,
      detail: [p.spearman !== null ? `Rank correlation agrees in sign: ${p.spearman > 0 === same ? "yes" : "no"}.` : "", "Correlation shows association, not cause."].filter(Boolean),
      facts: fs.facts, columns: [p.a, p.b],
      factors: { magnitude: clamp01((Math.abs(p.r) - 0.3) / 0.6), relevance: Math.max(metricRelevance(ctx, p.a), metricRelevance(ctx, p.b)) * 0.85, significance: clamp01(-Math.log10(Math.max(1e-12, p.p)) / 6), novelty: 1, confidence: p.n >= 100 ? CONFIDENCE_VALUE.high : CONFIDENCE_VALUE.medium, completeness: completenessOf(ctx, p.a, p.b) },
      confidence: (p.n >= 100 ? "high" : "medium") as "high" | "medium",
      caveats: ["Correlation is not causation, and a few extreme rows can drive it."],
      method: "Pearson correlation (with Spearman as a check) on paired non-blank values; pairs that are arithmetically related or share a name are excluded as tautological.",
      evidence: { tool: "correlation", params: { column_a: p.a, column_b: p.b } },
      followUps: [`Does the relationship between ${p.a} and ${p.b} hold within each ${candidateDimensions(ctx, 1)[0]?.name ?? "segment"}?`],
    };
  });
}

export function customerInsights(ctx: AnalysisContext): Candidate[] {
  const caps = ctx.profile.capabilities;
  if (!caps.customer) return [];
  const lead = leadOf(ctx);
  const metric = lead && lead.additive ? lead.column : undefined;
  let ca;
  try { ca = customerAnalysis(ctx.frame, ctx.rows, { customer: caps.customer, metric, topN: 5 }); } catch (e) { if (e instanceof AnalyticsError) return []; throw e; }
  if (ca.distinct < 20) return [];
  const fs = new FactSet(ctx.fmt, "f");
  const d = fs.num(`Distinct ${caps.customer}`, ca.distinct, "count");
  const rep = fs.num("Repeat rate", ca.repeat.ratePct, "percent");
  let summary = `${d.display} distinct ${caps.customer} values appear in the data; ${rep.display} of them have more than one row.`;
  let magnitude = 0.35;
  const detail: string[] = [];
  const conc = ca.value.concentration;
  if (metric && ca.value.topDecileShare !== null && conc && conc.k >= 20) {
    const td = fs.num(`Share of ${metric} from the top 10% of ${caps.customer}`, ca.value.topDecileShare, "percent");
    const cnt = fs.num("Customers in the top 10%", ca.value.topDecileCount, "count");
    if (ca.value.topDecileShare >= 25) {
      summary += ` The top decile (${cnt.display} customers) generate ${td.display} of ${metric}.`;
      magnitude = clamp01((ca.value.topDecileShare - 10) / 40);
    }
  }
  const informative = ca.repeat.ratePct >= 5 && ca.repeat.ratePct <= 95 || (metric && ca.value.topDecileShare !== null && ca.value.topDecileShare >= 25);
  if (!informative) return [];
  return [{
    id: insightId("customers", caps.customer), kind: "customers", category: catOf("customers"), subject: caps.customer,
    title: `Customer base: repeat behaviour and value concentration`, summary, detail, facts: fs.facts, columns: [caps.customer, ...(metric ? [metric] : [])],
    factors: { magnitude, relevance: 0.9, significance: 0.6, novelty: 1, confidence: CONFIDENCE_VALUE.high, completeness: completenessOf(ctx, caps.customer, metric) },
    confidence: "high", caveats: ca.rowsWithoutCustomer ? [`${ca.rowsWithoutCustomer} rows have no ${caps.customer} value and are ignored here.`] : [],
    method: "Rows are grouped by customer; repeat rate = customers with more than one row ÷ all customers; value share uses summed metric.",
    evidence: { tool: "customer_analysis", params: { customer: caps.customer, metric: metric ?? null } },
    followUps: [`Who are the top 10 ${caps.customer} values by ${lbl(lead)}?`, "How does customer retention look by cohort?"],
  }];
}

export function forecastInsights(ctx: AnalysisContext): Candidate[] {
  const caps = ctx.profile.capabilities;
  if (!caps.forecast) return [];
  const lead = leadOf(ctx);
  if (lead && !lead.additive) return [];
  const b = seriesFor(ctx, { metric: lead?.column, agg: lead ? "sum" : "count" });
  const f = forecast(b.complete.points, b.grain, 3, { fillGapsWithZero: true });
  if (!f.ok || !f.model || !f.points.length) return [];
  const label = lbl(lead), sc = lead?.scale ?? 1, unit = lead?.unit ?? "count";
  const next = f.points[0]!;
  const last = b.complete.points[b.complete.points.length - 1]!;
  const fs = new FactSet(ctx.fmt, "f");
  const v = fs.num(`Forecast for ${next.period}`, next.value * sc, unit), lo = fs.num("Lower bound", next.lo * sc, unit), hi = fs.num("Upper bound", next.hi * sc, unit);
  const per = fs.text("Forecast period", next.period, "date");
  const mape = f.backtest?.mape ?? null;
  const mp = mape !== null ? fs.num("Backtest error", mape, "percent") : null;
  const conf = f.confidence.toLowerCase() as "high" | "moderate" | "low";
  const confKey = conf === "moderate" ? "medium" : conf;
  const nar = forecastNarrative(f, fs);
  const chart: ChartSpec = {
    kind: "line", title: `${label}: history and forecast`, unit, currency: ctx.fmt.currency,
    x: [...b.complete.points.slice(-18).map((p) => p.period), ...f.points.map((p) => p.period)],
    series: [
      { name: label, values: [...b.complete.points.slice(-18).map((p) => p.value * sc), ...f.points.map(() => null)] },
      { name: "Forecast", style: "forecast", values: [...b.complete.points.slice(-18).map((_, i, a) => (i === a.length - 1 ? last.value * sc : null)), ...f.points.map((p) => p.value * sc)], lo: [...b.complete.points.slice(-18).map(() => null), ...f.points.map((p) => p.lo * sc)], hi: [...b.complete.points.slice(-18).map(() => null), ...f.points.map((p) => p.hi * sc)] },
    ],
  };
  return [{
    id: insightId("forecast", label), kind: "forecast", category: catOf("forecast"), subject: label,
    title: `${label} outlook`,
    summary: `${label} for ${per.display} is projected at ${v.display} (range ${lo.display} to ${hi.display}), model: ${f.model.label.toLowerCase()}; confidence is ${f.confidence.toLowerCase()}${mp ? ` (backtest error ${mp.display})` : ""}.`,
    detail: nar.assumptions, facts: fs.facts, columns: lead ? [lead.column] : [],
    factors: { magnitude: clamp01(Math.abs((next.value - last.value) / Math.max(1e-9, Math.abs(last.value))) / 0.3), relevance: lead ? metricRelevance(ctx, lead.column) : 0.6, significance: 0.5, novelty: 1, confidence: CONFIDENCE_VALUE[confKey], completeness: completenessOf(ctx, lead?.column) },
    confidence: confKey, caveats: [...nar.limitations, nar.intervalNote],
    method: `${f.model.label}, chosen by rolling-origin backtest on the most recent periods; the interval is an approximation.`,
    evidence: { tool: "forecast", params: { metric: lead?.column ?? null, horizon: 3 } },
    followUps: [`What assumptions does the ${label} forecast rely on?`], chart,
  }];
}

export function qualityInsights(ctx: AnalysisContext): Candidate[] {
  const out: Candidate[] = [];
  for (const issue of ctx.profile.quality.issues) {
    const fs = new FactSet(ctx.fmt, "f");
    const n = fs.num("Affected", issue.affected, "count");
    let summary: string | null = null;
    if (issue.kind === "duplicate_rows") {
      const pct = fs.num("Duplicate share", ctx.profile.duplicatePct, "percent");
      summary = `${n.display} rows (${pct.display}) exactly repeat an earlier row; if they are not genuine repeat transactions, totals are overstated.`;
    } else if (issue.kind === "missing_values" && issue.column) {
      const c = ctx.profile.columns.find((x) => x.name === issue.column);
      if (!c) continue;
      const pct = fs.num("Blank share", c.missingPct, "percent");
      summary = `"${issue.column}" is blank in ${n.display} rows (${pct.display}); those rows are left out of any calculation on it.`;
    } else if (issue.kind === "invalid_values" && issue.column) {
      summary = `${n.display} values in "${issue.column}" could not be read and were left blank rather than guessed.`;
    } else if (issue.kind === "ambiguous_dates" && issue.column) {
      summary = `Dates in "${issue.column}" could be read day-first or month-first; confirm the order because a wrong guess swaps days and months.`;
    } else if (issue.kind === "inconsistent_labels" && issue.column) {
      summary = `"${issue.column}" has inconsistent spellings of the same label (${n.display} rows affected), which splits groups in rankings.`;
    } else continue;
    const sev = issue.kind === "duplicate_rows" ? clamp01(ctx.profile.duplicatePct / 3)
      : issue.kind === "missing_values" ? clamp01((ctx.profile.columns.find((x) => x.name === issue.column)?.missingPct ?? 0) / 40)
      : issue.severity === "high" ? 1 : issue.severity === "medium" ? 0.6 : 0.3;
    out.push({
      id: insightId("quality", issue.id), kind: "quality", category: "quality", subject: issue.kind,
      title: issue.kind === "duplicate_rows" ? "Duplicate rows may inflate totals" : issue.kind === "missing_values" ? `Missing values in ${issue.column}` : issue.kind === "invalid_values" ? `Unreadable values in ${issue.column}` : issue.kind === "ambiguous_dates" ? "Date order is ambiguous" : "Inconsistent labels",
      summary, detail: [issue.fix], facts: fs.facts, columns: issue.column ? [issue.column] : [],
      factors: { magnitude: sev, relevance: 0.5, significance: 0.7, novelty: 1, confidence: CONFIDENCE_VALUE.high, completeness: 1 },
      confidence: "high", caveats: [], method: "Detected during ingestion and profiling; the original file is never modified.",
      evidence: { tool: "describe_dataset", params: {} },
      followUps: ["How does the data quality affect the headline numbers?"],
    });
  }
  return out;
}
