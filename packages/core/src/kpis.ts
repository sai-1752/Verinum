/**
 * Headline KPIs. Totals span all active rows; the change indicator always compares the last two
 * COMPLETE, adjacent periods (a partial edge period is never used as a comparison anchor —
 * prototype safeguards 3–5), and refuses to print a percentage when the base is negligible.
 */
import { aggregate, latestPair, marginSeries, metricSpec, scaled, seriesFor, type AnalysisContext } from "./context";
import { FactSet, type Fact } from "./facts";
import { formatValue, type Unit } from "./format";
import { AnalyticsError } from "./analytics/errors";
import { median, pctChange } from "./stats";
import type { SeriesPoint } from "./analytics/periods";

export interface KpiDelta {
  /** % change, null when the base period is too small for a meaningful percentage */
  pct: number | null;
  /** change in display units (percentage points for percent KPIs) */
  abs: number;
  currentPeriod: string;
  previousPeriod: string;
  direction: "up" | "down" | "flat";
  unit: Unit;
  displayAbs: string;
  displayPct: string | null;
}

export interface Kpi {
  id: string;
  label: string;
  column: string | null;
  agg: string;
  unit: Unit;
  value: number | null;
  display: string;
  delta: KpiDelta | null;
  sparkline: number[];
  sparklineLabels: string[];
  caveats: string[];
  facts: Fact[];
}

const MAX_SPARK = 24;

function deltaFrom(current: SeriesPoint, previous: SeriesPoint, ctx: AnalysisContext, unit: Unit, scale: number, fs: FactSet): { delta: KpiDelta; caveat?: string } {
  const a = current.value * scale, b = previous.value * scale;
  const abs = a - b;
  let pct = pctChange(current.value, previous.value);
  let caveat: string | undefined;
  if (pct !== null && (Math.abs(previous.value) < 1e-9)) pct = null;
  const direction: KpiDelta["direction"] = pct !== null ? (Math.abs(pct) < 0.5 ? "flat" : pct > 0 ? "up" : "down") : abs === 0 ? "flat" : abs > 0 ? "up" : "down";
  const absFact = fs.num("Change vs previous period", abs, unit === "percent" ? "percent" : unit, { signed: true });
  const pctFact = pct !== null ? fs.num("Percent change vs previous period", pct, "percent", { signed: true }) : null;
  if (pct === null) caveat = "The previous period is too small for a meaningful percentage change.";
  return {
    caveat,
    delta: {
      pct, abs, currentPeriod: current.period, previousPeriod: previous.period, direction, unit,
      displayAbs: absFact.display, displayPct: pctFact?.display ?? null,
    },
  };
}

function sparkOf(points: SeriesPoint[], scale: number) {
  const tail = points.slice(-MAX_SPARK);
  return { sparkline: tail.map((p) => p.value * scale), sparklineLabels: tail.map((p) => p.period) };
}

export function computeKpis(ctx: AnalysisContext, o: { max?: number } = {}): Kpi[] {
  const caps = ctx.profile.capabilities;
  const out: Kpi[] = [];
  const canSeries = caps.timeSeries;

  const tryDelta = (metric: string | null, agg: "sum" | "avg" | "count", spec: ReturnType<typeof metricSpec> | null, fs: FactSet) => {
    if (!canSeries) return { delta: null as KpiDelta | null, spark: { sparkline: [] as number[], sparklineLabels: [] as string[] }, caveats: [] as string[] };
    try {
      const b = seriesFor(ctx, { metric: metric ?? undefined, agg });
      const pair = latestPair(b.complete.points);
      const caveats: string[] = [...b.complete.notes];
      const scale = spec?.scale ?? 1;
      const unit: Unit = spec ? spec.unit : "count";
      let delta: KpiDelta | null = null;
      if (pair) {
        const medianVal = median(b.complete.points.map((p) => Math.abs(p.value)));
        const smallBase = Math.abs(pair.previous.value) < 0.05 * medianVal;
        const r = deltaFrom(pair.current, pair.previous, ctx, unit, scale, fs);
        if (smallBase) { r.delta.pct = null; r.delta.displayPct = null; r.delta.direction = r.delta.abs === 0 ? "flat" : r.delta.abs > 0 ? "up" : "down"; r.caveat = "The previous period is unusually small, so a percentage change would be misleading."; }
        delta = r.delta;
        if (r.caveat) caveats.push(r.caveat);
      }
      return { delta, spark: sparkOf(b.complete.points, scale), caveats };
    } catch (e) {
      if (e instanceof AnalyticsError) return { delta: null, spark: { sparkline: [], sparklineLabels: [] }, caveats: [] };
      throw e;
    }
  };

  // 1) rows
  {
    const fs = new FactSet(ctx.fmt, "k1_");
    const v = ctx.rowCount;
    const value = fs.num("Number of rows", v, "count");
    const { delta, spark, caveats } = tryDelta(null, "count", null, fs);
    out.push({ id: "rows", label: "Rows", column: null, agg: "count", unit: "count", value: v, display: value.display, delta, ...spark, caveats, facts: fs.facts });
  }

  // 2) measures: lead first, then other additive measures by business priority, then a couple of non-additive
  const order: string[] = [];
  if (caps.leadMetric) order.push(caps.leadMetric);
  for (const c of [caps.profit, caps.quantity, caps.cost, caps.marketing]) if (c && !order.includes(c)) order.push(c);
  for (const c of caps.additiveMeasures) if (!order.includes(c) && order.length < 5) order.push(c);
  for (const c of [caps.price, caps.discount]) if (c && !order.includes(c) && order.length < 6) order.push(c);
  let idx = 2;
  for (const column of order) {
    if (out.length >= (o.max ?? 8)) break;
    const spec = metricSpec(ctx, column);
    const fs = new FactSet(ctx.fmt, `k${idx++}_`);
    const raw = aggregate(ctx, spec.agg, column);
    if (raw.value === null) continue;
    const v = scaled(spec, raw.value);
    const label = `${spec.agg === "sum" ? "Total" : "Average"} ${column}`;
    const fact = fs.num(label, v, spec.unit);
    const { delta, spark, caveats } = tryDelta(column, spec.agg, spec, fs);
    if (raw.blanks > 0) caveats.push(`${raw.blanks} rows have no ${column} value and are excluded.`);
    out.push({ id: `m:${column}`, label, column, agg: spec.agg, unit: spec.unit, value: v, display: fact.display, delta, ...spark, caveats, facts: fs.facts });
  }

  // 3) margin (only from an additive profit amount and a revenue amount)
  if (caps.margin && caps.revenue && caps.profit) {
    const fs = new FactSet(ctx.fmt, "km_");
    const rev = aggregate(ctx, "sum", caps.revenue).value ?? 0, prof = aggregate(ctx, "sum", caps.profit).value ?? 0;
    if (rev) {
      const m = (prof / rev) * 100;
      const fact = fs.num("Profit margin", m, "percent");
      let delta: KpiDelta | null = null;
      let spark = { sparkline: [] as number[], sparklineLabels: [] as string[] };
      const caveats: string[] = [];
      if (canSeries) {
        try {
          const ms = marginSeries(ctx);
          const pts = ms ? ms.points : [];
          const pair = latestPair(pts);
          if (pair) {
            const abs = pair.current.value - pair.previous.value;
            const f = fs.num("Margin change vs previous period", abs, "percent", { signed: true });
            delta = { pct: null, abs, currentPeriod: pair.current.period, previousPeriod: pair.previous.period, direction: Math.abs(abs) < 0.1 ? "flat" : abs > 0 ? "up" : "down", unit: "percent", displayAbs: f.display.replace("%", " pts"), displayPct: null };
          }
          spark = sparkOf(pts, 1);
        } catch (e) { if (!(e instanceof AnalyticsError)) throw e; }
      }
      out.push({ id: "margin", label: "Profit margin", column: null, agg: "ratio", unit: "percent", value: m, display: fact.display, delta, ...spark, caveats, facts: fs.facts });
    }
  }

  // 4) distinct customers
  if (caps.customer && out.length < (o.max ?? 8) + 1) {
    const fs = new FactSet(ctx.fmt, "kc_");
    const d = aggregate(ctx, "distinct_count", caps.customer);
    if (d.value !== null) {
      const f = fs.num(`Distinct ${caps.customer}`, d.value, "count");
      out.push({ id: "customers", label: `Distinct ${caps.customer}`, column: caps.customer, agg: "distinct_count", unit: "count", value: d.value, display: f.display, delta: null, sparkline: [], sparklineLabels: [], caveats: d.blanks ? [`${d.blanks} rows have no ${caps.customer}.`] : [], facts: fs.facts });
    }
  }
  return out;
}

export function kpiLine(k: Kpi): string {
  return `${k.label}: ${k.display}${k.delta ? ` (${k.delta.displayPct ?? k.delta.displayAbs} vs ${k.delta.previousPeriod})` : ""}`;
}

export { formatValue };
