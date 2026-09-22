import { periodKey, seasonLength, type Grain } from "../time";
import { linreg, mean, stdev } from "../stats";
import { gapFraction, type SeriesPoint } from "./periods";

export type ForecastModelName = "level" | "linear" | "seasonal_linear";
export const MODEL_LABEL: Record<ForecastModelName, string> = {
  level: "Flat level (mean of the last 3 periods)",
  linear: "Ordinary least-squares linear trend",
  seasonal_linear: "Linear trend × seasonal index",
};

export interface ForecastPoint {
  ord: number;
  period: string;
  value: number;
  lo: number;
  hi: number;
  forecast: true;
}

export interface ForecastResult {
  ok: boolean;
  reason?: string;
  grain: Grain;
  horizon: number;
  model?: { name: ForecastModelName; label: string };
  points: ForecastPoint[];
  historyPeriods: number;
  filledGaps: number;
  trendR2: number | null;
  slopePerPeriod: number | null;
  backtest: { folds: number; mape: number | null; compared: { model: ForecastModelName; mape: number | null }[] } | null;
  confidence: "High" | "Moderate" | "Low";
  intervalNote: string;
  assumptions: string[];
  limitations: string[];
}

export interface ForecastOptions {
  /** treat periods with no rows as 0 (valid for sums and counts, not for averages) */
  fillGapsWithZero?: boolean;
  /** clamp forecasts at zero when the history is non-negative */
  clampAtZero?: boolean;
}

interface Fitted {
  predict: (k: number) => number; // k = 0 is the first period after training
  resid: number[];
  r2: number | null;
  slope: number | null;
}

function fit(name: ForecastModelName, ords: number[], ys: number[], season: number): Fitted | null {
  const n = ys.length;
  if (name === "level") {
    const k = Math.min(3, n);
    const lvl = mean(ys.slice(n - k));
    return { predict: () => lvl, resid: ys.map((y) => y - lvl), r2: null, slope: 0 };
  }
  const reg = linreg(ys);
  if (name === "linear") {
    return { predict: (k) => reg.intercept + reg.slope * (n + k), resid: ys.map((y, i) => y - reg.fit[i]!), r2: reg.r2, slope: reg.slope };
  }
  if (season < 2 || n < season * 2) return null;
  if (reg.fit.some((f) => !(f > 0))) return null; // multiplicative index is undefined for non-positive trend
  const sums = new Array<number>(season).fill(0), cnt = new Array<number>(season).fill(0);
  ys.forEach((y, i) => { const p = ((ords[i]! % season) + season) % season; sums[p]! += y / reg.fit[i]!; cnt[p]!++; });
  if (cnt.some((c) => c === 0)) return null;
  let idx = sums.map((s, i) => s / cnt[i]!);
  const m = mean(idx);
  idx = idx.map((v) => v / m);
  const lastOrd = ords[n - 1]!;
  return {
    predict: (k) => {
      const p = (((lastOrd + 1 + k) % season) + season) % season;
      return (reg.intercept + reg.slope * (n + k)) * idx[p]!;
    },
    resid: ys.map((y, i) => y - reg.fit[i]! * idx[((ords[i]! % season) + season) % season]!),
    r2: reg.r2, slope: reg.slope,
  };
}

function mapeOf(errs: { a: number; f: number }[]): number | null {
  const ok = errs.filter((e) => Math.abs(e.a) > 1e-9);
  if (!ok.length) return null;
  return mean(ok.map((e) => Math.abs(e.a - e.f) / Math.abs(e.a))) * 100;
}

const refuse = (grain: Grain, horizon: number, reason: string, n = 0): ForecastResult => ({
  ok: false, reason, grain, horizon, points: [], historyPeriods: n, filledGaps: 0, trendR2: null, slopePerPeriod: null,
  backtest: null, confidence: "Low", intervalNote: "", assumptions: [], limitations: [],
});

/**
 * Forecasts a complete-period series. It refuses rather than guess: too little history, gaps
 * that cannot be filled honestly, or recent behaviour so erratic that a backtest fails.
 * Model choice is by rolling-origin backtest, not by hope.
 */
export function forecast(points: SeriesPoint[], grain: Grain, horizon = 3, opts: ForecastOptions = {}): ForecastResult {
  horizon = Math.min(12, Math.max(1, Math.floor(horizon)));
  const raw = points;
  if (raw.length < 6) return refuse(grain, horizon, `Only ${raw.length} complete ${grain}${raw.length === 1 ? "" : "s"} of history are available. At least 6 are needed before a trend estimate is meaningful.`, raw.length);

  let pts = raw;
  let filled = 0;
  if (gapFraction(raw) > 0) {
    if (!opts.fillGapsWithZero) return refuse(grain, horizon, `The series has missing ${grain}s inside its range and they cannot be treated as zero for this measure, so a forecast would not be reliable.`, raw.length);
    const span = raw[raw.length - 1]!.ord - raw[0]!.ord + 1;
    if ((span - raw.length) / span > 0.2) return refuse(grain, horizon, `More than 20% of the ${grain}s in the history have no rows, so filling them with zero would dominate the forecast.`, raw.length);
    const byOrd = new Map(raw.map((p) => [p.ord, p]));
    pts = [];
    for (let o = raw[0]!.ord; o <= raw[raw.length - 1]!.ord; o++) {
      const p = byOrd.get(o);
      if (p) pts.push(p); else { filled++; pts.push({ ord: o, period: periodKey(o, grain), startDay: 0, endDay: 0, n: 0, value: 0 }); }
    }
  }
  const ords = pts.map((p) => p.ord), ys = pts.map((p) => p.value);
  const n = ys.length;
  const season = seasonLength(grain);
  const nonNeg = (opts.clampAtZero ?? true) && ys.every((y) => y >= 0);

  // ---- rolling-origin backtest over the most recent periods (one-step-ahead) ----
  const T = Math.min(6, Math.max(2, Math.floor(n / 3)));
  const names: ForecastModelName[] = ["level", "linear", "seasonal_linear"];
  const perModel = new Map<ForecastModelName, { a: number; f: number }[]>();
  for (const name of names) {
    const errs: { a: number; f: number }[] = [];
    let valid = true;
    for (let t = n - T; t < n; t++) {
      const fm = fit(name, ords.slice(0, t), ys.slice(0, t), season);
      if (!fm) { valid = false; break; }
      errs.push({ a: ys[t]!, f: fm.predict(0) });
    }
    if (valid) perModel.set(name, errs);
  }
  const compared = [...perModel.entries()].map(([model, errs]) => ({ model, mape: mapeOf(errs) }));
  const rank = { level: 0, linear: 1, seasonal_linear: 2 } as const;
  let best: { model: ForecastModelName; mape: number | null } | null = null;
  for (const c of compared) {
    if (c.mape === null) continue;
    if (!best || c.mape < best.mape! * (c.model === "seasonal_linear" ? 0.9 : 1) || (best.mape !== null && Math.abs(c.mape - best.mape) < 1e-9 && rank[c.model] < rank[best.model])) best = c;
  }
  if (best && best.model === "seasonal_linear") {
    const lin = compared.find((c) => c.model === "linear");
    if (lin && lin.mape !== null && best.mape! > lin.mape * 0.9) best = lin; // seasonal must clearly beat linear
  }
  const chosen: ForecastModelName = best ? best.model : "linear";
  const fm = fit(chosen, ords, ys, season) ?? fit("linear", ords, ys, season)!;
  const mape = best ? best.mape : null;

  if (mape !== null && mape > 150) {
    return refuse(grain, horizon, `Recent ${grain}s are too erratic to forecast responsibly: even the best model missed by about ${mape.toFixed(0)}% on average when tested on the last ${T} periods.`, n);
  }

  const btErr = perModel.get(chosen)?.map((e) => e.a - e.f) ?? [];
  const sigma = btErr.length >= 3 ? Math.sqrt(mean(btErr.map((e) => e * e))) : stdev(fm.resid) || 0;
  const lastOrd = ords[n - 1]!;
  const out: ForecastPoint[] = [];
  for (let k = 0; k < horizon; k++) {
    let v = fm.predict(k);
    const widen = Math.sqrt(1 + (k + 1) / n) * 1.96 * sigma;
    let lo = v - widen, hi = v + widen;
    if (nonNeg) { v = Math.max(0, v); lo = Math.max(0, lo); hi = Math.max(0, hi); }
    out.push({ ord: lastOrd + 1 + k, period: periodKey(lastOrd + 1 + k, grain), value: v, lo, hi, forecast: true });
  }

  const confidence: ForecastResult["confidence"] = mape === null ? "Low" : n >= 24 && mape < 10 ? "High" : n >= 12 && mape < 20 ? "Moderate" : "Low";
  const seasonalUsed = chosen === "seasonal_linear";
  return {
    ok: true, grain, horizon, model: { name: chosen, label: MODEL_LABEL[chosen] }, points: out,
    historyPeriods: n, filledGaps: filled, trendR2: fm.r2, slopePerPeriod: fm.slope,
    backtest: { folds: T, mape, compared },
    confidence,
    intervalNote: `Shaded band is a ±1.96 × error-σ range (σ from ${btErr.length >= 3 ? `a backtest over the last ${T} periods` : "in-sample residuals"}), widened with the horizon. It is an approximation, not a guarantee.`,
    assumptions: [
      `Assumes the historical ${grain}ly pattern continues unchanged.`,
      seasonalUsed ? `Seasonality is estimated from ${Math.floor(n / season)} full cycles, so seasonal factors are approximate.` : "No seasonal component is used (history too short, or a seasonal model did not clearly beat the simpler one in testing).",
      "No external drivers (pricing changes, campaigns, supply shocks) are modelled.",
      ...(filled ? [`${filled} ${grain}${filled > 1 ? "s" : ""} with no rows were treated as zero.`] : []),
    ],
    limitations: [
      mape === null ? "The model could not be backtested, so accuracy is unknown." : `Tested on the last ${T} periods, the chosen model's average error was ${mape.toFixed(1)}%.`,
      fm.r2 !== null && fm.r2 < 0.4 ? `The trend explains little of the variation (R² ${fm.r2.toFixed(2)}), so treat the level as indicative only.` : `Based on ${n} periods of history.`,
      "This is a forecast estimate, not a guaranteed outcome.",
    ],
  };
}
