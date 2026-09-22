import { linreg, mannKendallTau, mean, stdev, pctChange } from "../stats";
import type { SeriesPoint } from "./periods";

export interface TrendResult {
  n: number;
  slope: number;
  /** slope as % of the series mean, per period */
  slopePctOfMean: number;
  /** change in the *fitted* line from first to last period, % of the fitted start */
  fittedChangePct: number | null;
  /** change between the first and last observed values (noisy; reported for transparency) */
  endpointChangePct: number | null;
  r2: number;
  slopeP: number;
  tau: number;
  direction: "rising" | "falling" | "flat";
  /** true only when the direction is statistically and practically supported */
  significant: boolean;
  volatilityCV: number;
  acceleration: { firstHalfSlope: number; secondHalfSlope: number; kind: "accelerating" | "decelerating" | "steady" } | null;
  first: SeriesPoint;
  last: SeriesPoint;
}

export function trendAnalysis(points: SeriesPoint[]): TrendResult | null {
  const n = points.length;
  if (n < 4) return null;
  const ys = points.map((p) => p.value);
  const reg = linreg(ys);
  const m = mean(ys);
  const tau = mannKendallTau(ys);
  const fitStart = reg.fit[0]!, fitEnd = reg.fit[n - 1]!;
  const fittedChangePct = Math.abs(fitStart) > 1e-12 ? ((fitEnd - fitStart) / Math.abs(fitStart)) * 100 : null;
  const slopePct = Math.abs(m) > 1e-12 ? (reg.slope / Math.abs(m)) * 100 : 0;
  const significant = reg.slopeP < 0.05 && Math.abs(tau) >= 0.2 && Math.abs(slopePct) >= 0.5;
  let acceleration: TrendResult["acceleration"] = null;
  if (n >= 8) {
    const h = Math.floor(n / 2);
    const a = linreg(ys.slice(0, h)).slope, b = linreg(ys.slice(h)).slope;
    const scale = Math.abs(m) || 1;
    const da = a / scale, db = b / scale;
    const kind = Math.abs(db - da) < 0.01 ? "steady" : db > da ? "accelerating" : "decelerating";
    acceleration = { firstHalfSlope: a, secondHalfSlope: b, kind };
  }
  return {
    n, slope: reg.slope, slopePctOfMean: slopePct, fittedChangePct,
    endpointChangePct: pctChange(ys[n - 1]!, ys[0]!),
    r2: reg.r2, slopeP: reg.slopeP, tau,
    direction: significant ? (reg.slope > 0 ? "rising" : "falling") : "flat",
    significant, volatilityCV: Math.abs(m) > 1e-12 ? stdev(ys) / Math.abs(m) : 0,
    acceleration, first: points[0]!, last: points[n - 1]!,
  };
}
