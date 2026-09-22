/**
 * Period logic, including the partial-period safeguard.
 *
 * `completePeriods` trims leading/trailing buckets that are only slivers of a period — a
 * mid-month extract, a fiscal boundary — so that first-vs-last comparisons and headlines are
 * never anchored on incomplete data (prototype safeguards 3-4, extended with calendar coverage).
 */
import { periodEndDays, periodKey, periodLengthDays, periodStartDays, type Grain } from "../time";

export interface SeriesPoint {
  ord: number;
  period: string;
  startDay: number;
  endDay: number;
  /** rows (with a usable value) that fell in the period */
  n: number;
  value: number;
}

export interface TimeSeries {
  dateColumn: string;
  metric: string | null;
  agg: string;
  grain: Grain;
  points: SeriesPoint[];
  /** ordinals with no rows inside the observed range */
  missingOrdinals: number[];
  rowsUsed: number;
  rowsWithoutDate: number;
  minDay: number;
  maxDay: number;
}

export interface CompleteSeries {
  points: SeriesPoint[];
  trimmedStart: number;
  trimmedEnd: number;
  partialStart: SeriesPoint | null;
  partialEnd: SeriesPoint | null;
  /** plain-language notes for methodology / caveats */
  notes: string[];
}

export interface CompleteOptions {
  /** an edge period holding fewer rows than this share of the median period is partial */
  minShare?: number;
  /** an edge period covering less than this share of its calendar span is partial */
  minCoverage?: number;
}

export function completePeriods(series: TimeSeries, opts: CompleteOptions = {}): CompleteSeries {
  const minShare = opts.minShare ?? 0.3;
  const minCoverage = opts.minCoverage ?? 0.8;
  const pts = series.points;
  const none: CompleteSeries = { points: pts, trimmedStart: 0, trimmedEnd: 0, partialStart: null, partialEnd: null, notes: [] };
  if (pts.length < 3) return none;

  const counts = pts.map((p) => p.n).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] || 0;
  if (!median) return none;
  const floor = median * minShare;

  const coverageStart = (p: SeriesPoint) =>
    series.grain === "day" ? 1 : (p.endDay - Math.max(p.startDay, series.minDay) + 1) / periodLengthDays(p.ord, series.grain);
  const coverageEnd = (p: SeriesPoint) =>
    series.grain === "day" ? 1 : (Math.min(p.endDay, series.maxDay) - p.startDay + 1) / periodLengthDays(p.ord, series.grain);

  let a = 0, b = pts.length;
  const firstOrd = pts[0]!.ord, lastOrd = pts[pts.length - 1]!.ord;
  while (b - a > 3 && (pts[a]!.n < floor || (pts[a]!.ord === firstOrd && coverageStart(pts[a]!) < minCoverage))) a++;
  while (b - a > 3 && (pts[b - 1]!.n < floor || (pts[b - 1]!.ord === lastOrd && coverageEnd(pts[b - 1]!) < minCoverage))) b--;

  const notes: string[] = [];
  const trimmed = a + (pts.length - b);
  if (trimmed) {
    notes.push(`The partial ${series.grain}${trimmed > 1 ? "s" : ""} at the edge of the data ${trimmed > 1 ? "were" : "was"} excluded from trends and comparisons (too few rows, or too little of the calendar period covered).`);
  }
  return {
    points: pts.slice(a, b), trimmedStart: a, trimmedEnd: pts.length - b,
    partialStart: a > 0 ? pts[a - 1]! : null, partialEnd: b < pts.length ? pts[b]! : null, notes,
  };
}

export function makePoint(ord: number, grain: Grain, n: number, value: number): SeriesPoint {
  return { ord, period: periodKey(ord, grain), startDay: periodStartDays(ord, grain), endDay: periodEndDays(ord, grain), n, value };
}

/** Longest run of consecutive ordinals is used for models that need an evenly spaced series. */
export function gapFraction(points: SeriesPoint[]): number {
  if (points.length < 2) return 0;
  const span = points[points.length - 1]!.ord - points[0]!.ord + 1;
  return 1 - points.length / span;
}
