import { computeKpis } from "../kpis";
import { FactSet } from "../facts";
import { AnalyticsError } from "../analytics/errors";
import type { AnalysisContext } from "../context";
import { ANALYSIS_VERSION } from "../types";
import { formatIsoDate } from "../time";
import {
  anomalyInsights, candidateDimensions, correlationInsights, customerInsights, forecastInsights, groupInsights,
  periodChangeInsights, profitabilityInsights, qualityInsights, seasonalityInsights, trendInsights,
} from "./generators";
import { rankCandidates, type RankOptions } from "./rank";
import type { Candidate, ExecutiveSummary, InsightReport } from "./types";

export * from "./types";
export { rankCandidates, scoreOf, priorityOf } from "./rank";
export { candidateDimensions, insightId, joinList } from "./generators";

/** Runs every generator; a generator that legitimately cannot run (AnalyticsError) is skipped, anything else is a bug and propagates. */
export function generateInsights(ctx: AnalysisContext, o: RankOptions = {}): InsightReport {
  const cands: Candidate[] = [];
  const run = (fn: () => Candidate[]) => {
    try { cands.push(...fn()); } catch (e) { if (!(e instanceof AnalyticsError)) throw e; }
  };
  if (ctx.rowCount > 0) {
    for (const d of candidateDimensions(ctx, 5)) run(() => groupInsights(ctx, d));
    run(() => trendInsights(ctx));
    run(() => periodChangeInsights(ctx));
    run(() => anomalyInsights(ctx));
    run(() => seasonalityInsights(ctx));
    run(() => profitabilityInsights(ctx));
    run(() => correlationInsights(ctx));
    run(() => customerInsights(ctx));
    run(() => forecastInsights(ctx));
    run(() => qualityInsights(ctx));
  }
  const { insights, belowThreshold, duplicatesOfKind } = rankCandidates(cands, o);
  return {
    version: ANALYSIS_VERSION, rowsAnalysed: ctx.rowCount, insights,
    suppressed: { belowThreshold, duplicatesOfKind }, summary: executiveSummary(ctx, insights),
  };
}

export function executiveSummary(ctx: AnalysisContext, insights: InsightReport["insights"]): ExecutiveSummary {
  const fs = new FactSet(ctx.fmt, "s");
  const p = ctx.profile;
  const kpis = ctx.rowCount ? computeKpis(ctx, { max: 3 }) : [];
  const rows = fs.num("Rows analysed", ctx.rowCount, "count");
  let headline = `${rows.display} rows`;
  if (p.calendar) {
    const from = fs.text("First date", formatIsoDate(p.calendar.minDay), "date"), to = fs.text("Last date", formatIsoDate(p.calendar.maxDay), "date");
    headline += ` from ${from.display} to ${to.display}`;
  }
  const leadKpi = kpis.find((k) => k.id.startsWith("m:"));
  if (leadKpi) {
    const f = fs.num(leadKpi.label, leadKpi.value, leadKpi.unit);
    headline += `; ${leadKpi.label} is ${f.display}`;
    if (leadKpi.delta && leadKpi.delta.displayPct) {
      const d = fs.num("Latest period change", leadKpi.delta.pct, "percent", { signed: true });
      const per = fs.text("Latest period", leadKpi.delta.currentPeriod, "date");
      headline += `, ${d.display} in the latest complete period (${per.display})`;
    }
  }
  headline += ".";
  const top = insights.filter((i) => i.kind !== "quality").slice(0, 3);
  const bullets = top.map((i) => ({ insightId: i.id, text: i.summary }));
  const caveats: string[] = [];
  const q = fs.num("Data quality score", p.quality.score, "count"), qMax = fs.num("Maximum quality score", 100, "count");
  caveats.push(`Data quality is ${p.quality.label.toLowerCase()} (score ${q.display} of ${qMax.display}).`);
  if (p.calendar && (p.calendar.trimmedStart || p.calendar.trimmedEnd)) caveats.push(...p.calendar.notes);
  const ns = (prefix: string, list: { id: string }[]) => list.map((f) => ({ ...f, id: `${prefix}#${f.id}` }));
  const facts = [
    ...fs.facts,
    ...kpis.flatMap((k) => ns(k.id, k.facts) as typeof fs.facts),
    ...top.flatMap((i) => ns(i.id, i.facts) as typeof fs.facts),
  ];
  return { headline, bullets, caveats, facts };
}
export { structuralCorrelationReason } from "./generators";
