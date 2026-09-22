import { Frame, type RowSet } from "../frame";
import { pctChange } from "../stats";
import { AnalyticsError } from "./errors";
import { aggregateColumn } from "./aggregate";
import { BLANK, groupBy } from "./groupby";

export interface ProfitRow {
  key: string;
  isBlank: boolean;
  revenue: number;
  profit: number;
  margin: number | null; // %
  revenueShare: number;
  profitShare: number;
  /** revenue share − profit share, in points; positive = takes more revenue than profit */
  shareGap: number;
  rows: number;
  lossMaking: boolean;
}

export interface ProfitabilityResult {
  dimension: string | null;
  revenueColumn: string;
  profitColumn: string;
  overall: { revenue: number; profit: number; margin: number | null };
  groups: ProfitRow[];
  lossMakers: ProfitRow[];
  /** highest-revenue groups whose margin is well below the overall margin */
  highRevenueLowMargin: ProfitRow[];
}

/**
 * Margin uses SUM(profit) ÷ SUM(revenue). The profit column must be additive: a margin-% column
 * is not a profit amount (safeguard 8/10) — callers pass the additive profit column only.
 */
export function profitabilityAnalysis(
  frame: Frame, rows: RowSet, o: { revenue: string; profit: string; dimension?: string; minRowShare?: number },
): ProfitabilityResult {
  for (const c of [o.revenue, o.profit]) {
    const col = frame.get(c);
    if (!col) throw new AnalyticsError("unknown_column", `Column "${c}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
    if (col.kind !== "number") throw new AnalyticsError("wrong_type", `"${c}" is not numeric.`);
  }
  const rev = aggregateColumn(frame, rows, "sum", o.revenue).value ?? 0;
  const prof = aggregateColumn(frame, rows, "sum", o.profit).value ?? 0;
  const overall = { revenue: rev, profit: prof, margin: rev ? (prof / rev) * 100 : null };
  if (!o.dimension) return { dimension: null, revenueColumn: o.revenue, profitColumn: o.profit, overall, groups: [], lossMakers: [], highRevenueLowMargin: [] };

  const gr = groupBy(frame, rows, { dimension: o.dimension, metric: o.revenue, agg: "sum" });
  const gp = groupBy(frame, rows, { dimension: o.dimension, metric: o.profit, agg: "sum" });
  const pm = new Map(gp.groups.map((g) => [g.key, g]));
  const groups: ProfitRow[] = gr.groups.map((g) => {
    const p = pm.get(g.key);
    const profit = p?.value ?? 0;
    return {
      key: g.key, isBlank: g.isBlank, revenue: g.value, profit, margin: g.value ? (profit / g.value) * 100 : null,
      revenueShare: g.share ?? 0, profitShare: p?.share ?? 0, shareGap: (g.share ?? 0) - (p?.share ?? 0),
      rows: g.rows, lossMaking: profit < 0 && !g.isBlank,
    };
  });
  const minRowShare = o.minRowShare ?? 1;
  const material = groups.filter((g) => !g.isBlank && g.revenueShare >= 2 && (g.rows / Math.max(1, gr.rowsConsidered)) * 100 >= minRowShare);
  const lowMargin = overall.margin === null ? [] : material.slice(0, 8).filter((g) => g.margin !== null && g.margin < overall.margin! - 5 && g.shareGap > 3);
  return {
    dimension: o.dimension, revenueColumn: o.revenue, profitColumn: o.profit, overall, groups,
    lossMakers: groups.filter((g) => g.lossMaking), highRevenueLowMargin: lowMargin.sort((a, b) => b.shareGap - a.shareGap),
  };
}

export interface VolumeMarginEffect {
  revenueA: number; revenueB: number; profitA: number; profitB: number;
  marginA: number | null; marginB: number | null;
  profitChange: number;
  /** change in profit explained by revenue moving at the old margin */
  volumeEffect: number | null;
  /** change in profit explained by the margin rate moving on the new revenue */
  marginEffect: number | null;
  revenueChangePct: number | null;
  profitChangePct: number | null;
  marginChangePts: number | null;
}

/** ΔProfit = ΔRevenue × margin_B + Revenue_A × Δmargin — "why did profit fall while revenue rose?" */
export function volumeVsMargin(revenueA: number, profitA: number, revenueB: number, profitB: number): VolumeMarginEffect {
  const mA = revenueA ? profitA / revenueA : null, mB = revenueB ? profitB / revenueB : null;
  return {
    revenueA, revenueB, profitA, profitB,
    marginA: mA === null ? null : mA * 100, marginB: mB === null ? null : mB * 100,
    profitChange: profitA - profitB,
    volumeEffect: mB === null ? null : (revenueA - revenueB) * mB,
    marginEffect: mA === null || mB === null ? null : revenueA * (mA - mB),
    revenueChangePct: pctChange(revenueA, revenueB), profitChangePct: pctChange(profitA, profitB),
    marginChangePts: mA === null || mB === null ? null : (mA - mB) * 100,
  };
}

export { BLANK };
