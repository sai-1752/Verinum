import { civilFromDays } from "../time";
import { fPValue, mean } from "../stats";
import { MONTH_SHORT, WEEKDAY_SHORT, isoWeekday, type Grain } from "../time";
import type { SeriesPoint } from "./periods";

export interface SeasonalityResult {
  ok: boolean;
  reason?: string;
  cycle: "month-of-year" | "day-of-week";
  indices: { position: number; label: string; index: number; observations: number }[];
  peak?: { label: string; pctAboveAverage: number };
  trough?: { label: string; pctBelowAverage: number };
  spreadPct?: number;
  p?: number;
  significant?: boolean;
  fullCycles: number;
}

/**
 * Seasonality via ratio-to-centred-moving-average and a one-way ANOVA across calendar positions.
 * Requires at least two full cycles: the prototype reported "seasonal patterns" from ~1.5 years
 * of monthly data, which cannot distinguish seasonality from noise.
 */
export function seasonalityAnalysis(points: SeriesPoint[], grain: Grain): SeasonalityResult {
  const cycle = grain === "month" ? "month-of-year" : "day-of-week";
  const L = grain === "month" ? 12 : grain === "day" ? 7 : 0;
  const base: SeasonalityResult = { ok: false, cycle, indices: [], fullCycles: 0 };
  if (!L) return { ...base, reason: `Seasonality is analysed for monthly or daily data; this series is ${grain}ly.` };
  if (points.length < 2 * L) return { ...base, reason: `Seasonality needs at least two full ${L}-period cycles; only ${points.length} periods are available.`, fullCycles: Math.floor(points.length / L) };
  if (points.length < 2) return base;

  // require gap-free ordinals for a clean moving average
  for (let i = 1; i < points.length; i++) if (points[i]!.ord !== points[i - 1]!.ord + 1) return { ...base, reason: "Seasonality needs a series with no missing periods." };
  const ys = points.map((p) => p.value);
  // centred moving average of length L (2×L for even L)
  const ma: (number | null)[] = ys.map(() => null);
  const half = Math.floor(L / 2);
  for (let i = half; i < ys.length - half; i++) {
    let s = 0;
    if (L % 2 === 0) {
      for (let j = -half + 1; j <= half - 1; j++) s += ys[i + j]!;
      s += 0.5 * (ys[i - half]! + ys[i + half]!);
      ma[i] = s / L;
    } else {
      for (let j = -half; j <= half; j++) s += ys[i + j]!;
      ma[i] = s / L;
    }
  }
  const groups: number[][] = Array.from({ length: L }, () => []);
  points.forEach((p, i) => {
    const m = ma[i];
    if (m === null || !m || m <= 0) return;
    const pos = grain === "month" ? civilFromDays(p.startDay).m - 1 : isoWeekday(p.startDay);
    groups[pos]!.push(ys[i]! / m);
  });
  const usable = groups.filter((g) => g.length >= 2);
  const total = groups.reduce((s, g) => s + g.length, 0);
  if (usable.length < L || total < L * 2) return { ...base, reason: `After removing the moving-average edges, not every ${cycle === "month-of-year" ? "calendar month" : "weekday"} has two observations.`, fullCycles: Math.floor(points.length / L) };

  const grand = mean(groups.flat());
  let ssb = 0, ssw = 0;
  for (const g of groups) {
    const gm = mean(g);
    ssb += g.length * (gm - grand) ** 2;
    for (const v of g) ssw += (v - gm) ** 2;
  }
  const d1 = L - 1, d2 = total - L;
  const F = ssw > 0 ? ssb / d1 / (ssw / d2) : Infinity;
  const p = ssw > 0 ? fPValue(F, d1, d2) : 0;

  const indices = groups.map((g, pos) => ({
    position: pos, label: cycle === "month-of-year" ? MONTH_SHORT[pos]! : WEEKDAY_SHORT[pos]!,
    index: mean(g), observations: g.length,
  }));
  const sorted = [...indices].sort((a, b) => b.index - a.index);
  const hi = sorted[0]!, lo = sorted[sorted.length - 1]!;
  return {
    ok: true, cycle, indices,
    peak: { label: hi.label, pctAboveAverage: (hi.index - 1) * 100 },
    trough: { label: lo.label, pctBelowAverage: (1 - lo.index) * 100 },
    spreadPct: (hi.index - lo.index) * 100,
    p, significant: p < 0.05 && (hi.index - lo.index) > 0.1, fullCycles: Math.floor(points.length / L),
  };
}
