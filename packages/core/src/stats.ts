/** Statistical primitives. Pure functions over number arrays; no I/O, no dates. */

export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const b = Math.floor(pos);
  const r = pos - b;
  return b + 1 < n ? sorted[b]! + r * (sorted[b + 1]! - sorted[b]!) : sorted[b]!;
}

export interface NumStats {
  count: number;
  sum: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  std: number;
  variance: number;
  p05: number;
  q1: number;
  q3: number;
  p95: number;
  iqr: number;
  fenceLow: number;
  fenceHigh: number;
  outlierCount: number;
  outlierPct: number;
  zeros: number;
  negatives: number;
  skew: number;
}

/** Descriptive statistics over the finite values of `vals` (NaNs are ignored). */
export function numStats(vals: ArrayLike<number>): NumStats {
  const clean = new Float64Array(vals.length);
  let n = 0;
  for (let i = 0; i < vals.length; i++) { const v = vals[i]!; if (v === v && Number.isFinite(v)) clean[n++] = v; }
  const s = clean.subarray(0, n).slice();
  s.sort();
  if (!n) {
    return { count: 0, sum: 0, mean: NaN, median: NaN, min: NaN, max: NaN, std: NaN, variance: NaN, p05: NaN, q1: NaN, q3: NaN, p95: NaN, iqr: NaN, fenceLow: NaN, fenceHigh: NaN, outlierCount: 0, outlierPct: 0, zeros: 0, negatives: 0, skew: 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i]!;
  const mean = sum / n;
  let ss = 0, zeros = 0, negatives = 0;
  for (let i = 0; i < n; i++) { const d = s[i]! - mean; ss += d * d; if (s[i] === 0) zeros++; else if (s[i]! < 0) negatives++; }
  const variance = n > 1 ? ss / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const q1 = quantileSorted(s, 0.25), q3 = quantileSorted(s, 0.75);
  const iqr = q3 - q1;
  const fenceLow = q1 - 1.5 * iqr, fenceHigh = q3 + 1.5 * iqr;
  let outliers = 0, m3 = 0;
  for (let i = 0; i < n; i++) {
    const v = s[i]!;
    if (v < fenceLow || v > fenceHigh) outliers++;
    if (variance > 0) m3 += ((v - mean) / std) ** 3;
  }
  return {
    count: n, sum, mean, median: quantileSorted(s, 0.5), min: s[0]!, max: s[n - 1]!, std, variance,
    p05: quantileSorted(s, 0.05), q1, q3, p95: quantileSorted(s, 0.95), iqr, fenceLow, fenceHigh,
    outlierCount: outliers, outlierPct: (outliers / n) * 100, zeros, negatives,
    skew: variance > 0 ? m3 / n : 0,
  };
}

export interface HistBin { x0: number; x1: number; n: number }

/** Histogram between the 5th and 95th percentile (extremes fold into the end bins). */
export function histogram(vals: ArrayLike<number>, stats: NumStats, bins = 24): HistBin[] {
  const lo = stats.p05, hi = stats.p95;
  if (!(hi > lo)) return [];
  const w = (hi - lo) / bins;
  const out: HistBin[] = Array.from({ length: bins }, (_, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, n: 0 }));
  for (let k = 0; k < vals.length; k++) {
    const v = vals[k]!;
    if (v !== v) continue;
    let i = Math.floor((v - lo) / w);
    if (i < 0) i = 0;
    if (i >= bins) i = bins - 1;
    out[i]!.n++;
  }
  return out;
}

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return xs.length ? s / xs.length : NaN;
}

export function stdev(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (xs[i]! - m) ** 2;
  return Math.sqrt(ss / (n - 1));
}

export function median(xs: ArrayLike<number>): number {
  const s = Float64Array.from(xs as ArrayLike<number>).sort();
  return quantileSorted(s, 0.5);
}

/** Median absolute deviation (unscaled). */
export function mad(xs: ArrayLike<number>): { med: number; mad: number } {
  const med = median(xs);
  const dev = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) dev[i] = Math.abs(xs[i]! - med);
  return { med, mad: median(dev) };
}

/** Percentage change from b to a; null when the base is zero/near-zero. */
export function pctChange(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b) < 1e-12) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

/* ---------------------------- special functions ----------------------------- */

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for a Student-t statistic with `df` degrees of freedom. */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

/* ------------------------------- correlation -------------------------------- */

export interface CorrResult { r: number; n: number; p: number }

/** Pearson r over pairs where both values are finite. */
export function pearson(xs: ArrayLike<number>, ys: ArrayLike<number>): CorrResult | null {
  let n = 0, sx = 0, sy = 0;
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) { const a = xs[i]!, b = ys[i]!; if (a === a && b === b) { n++; sx += a; sy += b; } }
  if (n < 3) return null;
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < len; i++) {
    const a = xs[i]!, b = ys[i]!;
    if (a !== a || b !== b) continue;
    const da = a - mx, db = b - my;
    sxy += da * db; sxx += da * da; syy += db * db;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  const rc = Math.max(-1, Math.min(1, r));
  const t = rc * Math.sqrt((n - 2) / Math.max(1e-12, 1 - rc * rc));
  return { r: rc, n, p: Math.abs(rc) >= 1 ? 0 : tTwoSidedP(t, n - 2) };
}

function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation (robust to skew and outliers). */
export function spearman(xs: ArrayLike<number>, ys: ArrayLike<number>): CorrResult | null {
  const a: number[] = [], b: number[] = [];
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) { if (xs[i]! === xs[i]! && ys[i]! === ys[i]!) { a.push(xs[i]!); b.push(ys[i]!); } }
  if (a.length < 3) return null;
  return pearson(ranks(a), ranks(b));
}

/* ------------------------------- regression --------------------------------- */

export interface LinReg {
  slope: number;
  intercept: number;
  fit: number[];
  r2: number;
  residStd: number;
  /** two-sided p-value of the slope (t-test); 1 when n < 3 */
  slopeP: number;
}

export function linreg(ys: ArrayLike<number>): LinReg {
  const n = ys.length;
  const mx = (n - 1) / 2;
  let sy = 0;
  for (let i = 0; i < n; i++) sy += ys[i]!;
  const my = n ? sy / n : 0;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (ys[i]! - my); sxx += (i - mx) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const fit: number[] = new Array(n);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    fit[i] = intercept + slope * i;
    ssTot += (ys[i]! - my) ** 2;
    ssRes += (ys[i]! - fit[i]!) ** 2;
  }
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  const residStd = Math.sqrt(ssRes / Math.max(1, n - 2));
  let slopeP = 1;
  if (n >= 3 && sxx > 0) {
    const se = residStd / Math.sqrt(sxx);
    slopeP = se === 0 ? (slope === 0 ? 1 : 0) : tTwoSidedP(slope / se, n - 2);
  }
  return { slope, intercept, fit, r2, residStd, slopeP };
}

/** Mann-Kendall trend statistic (tau in [-1,1]) — robust direction check for short series. */
export function mannKendallTau(ys: ArrayLike<number>): number {
  const n = ys.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) s += Math.sign(ys[j]! - ys[i]!);
  return s / ((n * (n - 1)) / 2);
}

/** Upper-tail p-value of an F statistic with (d1, d2) degrees of freedom. */
export function fPValue(F: number, d1: number, d2: number): number {
  if (!Number.isFinite(F) || F <= 0 || d1 <= 0 || d2 <= 0) return 1;
  return incompleteBeta(d2 / (d2 + d1 * F), d2 / 2, d1 / 2);
}
