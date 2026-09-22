import { Frame, NULL_DATE, rowCountOf, type RowSet } from "../frame";
import { ordinalFromKey, periodEndDays, periodStartDays, formatIsoDate, type Grain } from "../time";
import { pctChange } from "../stats";
import { AnalyticsError } from "./errors";
import { aggregateColumn, type AggName } from "./aggregate";
import { dateRangeFromKey } from "./filter";
import { groupBy } from "./groupby";
import { concentration } from "./concentration";

export function periodRange(key: string, grain?: Grain): [number, number] | null {
  if (grain) {
    const ord = ordinalFromKey(key, grain);
    if (ord !== null) return [periodStartDays(ord, grain), periodEndDays(ord, grain)];
  }
  return dateRangeFromKey(key);
}

export function rowsInRange(frame: Frame, rows: RowSet, dateColumn: string, start: number, end: number): Uint32Array {
  const dc = frame.date(dateColumn);
  const total = rowCountOf(frame, rows);
  const out = new Uint32Array(total);
  let m = 0;
  for (let k = 0; k < total; k++) {
    const i = rows ? rows[k]! : k;
    const d = dc.values[i]!;
    if (d !== NULL_DATE && d >= start && d <= end) out[m++] = i;
  }
  return out.slice(0, m);
}

export interface PeriodValue {
  key: string;
  startDay: number;
  endDay: number;
  startIso: string;
  endIso: string;
  value: number | null;
  n: number;
  /** true when the data does not cover the whole period */
  partial: boolean;
}

export interface Contributor {
  key: string;
  isBlank: boolean;
  a: number;
  b: number;
  delta: number;
  pctChange: number | null;
  /** this group's delta as % of the net total delta (may exceed 100 or be negative) */
  shareOfChange: number | null;
}

export interface PeriodComparison {
  metric: string | null;
  agg: AggName;
  dateColumn: string;
  a: PeriodValue;
  b: PeriodValue;
  absoluteChange: number | null;
  percentChange: number | null;
  direction: "up" | "down" | "flat";
  warnings: string[];
  breakdown?: {
    dimension: string;
    contributors: Contributor[];
    /** how the change is distributed across groups */
    pattern: "concentrated" | "broad-based" | "mixed" | "none";
    patternExplanation: string;
    topContributorsShare: number | null;
    movedInSameDirection: number;
    groupsCompared: number;
  };
}

export interface CompareOptions {
  dateColumn: string;
  metric?: string;
  agg?: AggName;
  grain?: Grain;
  /** current period key (e.g. 2026-05, 2026-Q2, 2026) */
  periodA: string;
  /** baseline period key */
  periodB: string;
  breakdownDimension?: string;
  topN?: number;
}

/** share of a calendar period that the data range covers (same threshold as `completePeriods`) */
export const MIN_PERIOD_COVERAGE = 0.8;
function coverage(start: number, end: number, dataMin: number, dataMax: number): number {
  const len = end - start + 1;
  if (len <= 0) return 1;
  const covered = Math.min(end, dataMax) - Math.max(start, dataMin) + 1;
  return Math.max(0, covered) / len;
}

function valueFor(frame: Frame, rows: RowSet, o: CompareOptions, key: string, dataMin: number, dataMax: number): { pv: PeriodValue; rows: Uint32Array } {
  const r = periodRange(key, o.grain);
  if (!r) throw new AnalyticsError("invalid_argument", `"${key}" is not a valid period. Use an ISO date (2026-03-31), month (2026-03), quarter (2026-Q1) or year (2026).`);
  const sub = rowsInRange(frame, rows, o.dateColumn, r[0], r[1]);
  const agg = o.agg ?? (o.metric ? "sum" : "count");
  const res = aggregateColumn(frame, sub, agg, o.metric);
  return {
    rows: sub,
    pv: {
      key, startDay: r[0], endDay: r[1], startIso: formatIsoDate(r[0]), endIso: formatIsoDate(r[1]),
      value: sub.length ? res.value : null, n: res.n, partial: coverage(r[0], r[1], dataMin, dataMax) < MIN_PERIOD_COVERAGE,
    },
  };
}

export function comparePeriods(frame: Frame, rows: RowSet, o: CompareOptions, dataRange: { minDay: number; maxDay: number }): PeriodComparison {
  const agg: AggName = o.agg ?? (o.metric ? "sum" : "count");
  const A = valueFor(frame, rows, o, o.periodA, dataRange.minDay, dataRange.maxDay);
  const B = valueFor(frame, rows, o, o.periodB, dataRange.minDay, dataRange.maxDay);
  const warnings: string[] = [];
  for (const p of [A.pv, B.pv]) {
    if (p.n === 0) warnings.push(`No rows fall in ${p.key} (${p.startIso} to ${p.endIso}).`);
    else if (p.partial) warnings.push(`${p.key} is only partly covered by the data, so comparing it with a full period would exaggerate the change.`);
  }
  const abs = A.pv.value !== null && B.pv.value !== null ? A.pv.value - B.pv.value : null;
  const pct = A.pv.value !== null && B.pv.value !== null ? pctChange(A.pv.value, B.pv.value) : null;
  const out: PeriodComparison = {
    metric: o.metric ?? null, agg, dateColumn: o.dateColumn, a: A.pv, b: B.pv,
    absoluteChange: abs, percentChange: pct,
    direction: abs === null || abs === 0 || (pct !== null && Math.abs(pct) < 0.5) ? "flat" : abs > 0 ? "up" : "down",
    warnings,
  };

  if (o.breakdownDimension && (agg === "sum" || agg === "count") && abs !== null) {
    const ga = groupBy(frame, A.rows, { dimension: o.breakdownDimension, metric: o.metric, agg });
    const gb = groupBy(frame, B.rows, { dimension: o.breakdownDimension, metric: o.metric, agg });
    const bm = new Map(gb.groups.map((g) => [g.key, g]));
    const seen = new Set<string>();
    const contributors: Contributor[] = [];
    for (const g of ga.groups) {
      seen.add(g.key);
      const b = bm.get(g.key)?.value ?? 0;
      contributors.push({ key: g.key, isBlank: g.isBlank, a: g.value, b, delta: g.value - b, pctChange: pctChange(g.value, b), shareOfChange: abs !== 0 ? ((g.value - b) / abs) * 100 : null });
    }
    for (const g of gb.groups) if (!seen.has(g.key)) contributors.push({ key: g.key, isBlank: g.isBlank, a: 0, b: g.value, delta: -g.value, pctChange: -100, shareOfChange: abs !== 0 ? (-g.value / abs) * 100 : null });
    contributors.sort((x, y) => (abs < 0 ? x.delta - y.delta : y.delta - x.delta));

    // Pattern: is the change concentrated in a few groups or broad-based?
    const same = contributors.filter((c) => Math.sign(c.delta) === Math.sign(abs)).length;
    const top1 = contributors[0]?.shareOfChange ?? null;
    const top2 = contributors.length > 1 ? (contributors[0]!.shareOfChange ?? 0) + (contributors[1]!.shareOfChange ?? 0) : top1;
    let pattern: NonNullable<PeriodComparison["breakdown"]>["pattern"] = "mixed";
    let why = "";
    if (contributors.length < 2 || abs === 0) { pattern = "none"; why = "There are too few groups to say how the change is distributed."; }
    else if ((top1 ?? 0) >= 50 || (top2 ?? 0) >= 70) { pattern = "concentrated"; why = `The top ${(top1 ?? 0) >= 50 ? "group accounts" : "two groups account"} for ${Math.round((top1 ?? 0) >= 50 ? top1! : top2!)}% of the net change.`; }
    else if (same / contributors.length >= 0.7) { pattern = "broad-based"; why = `${same} of ${contributors.length} groups moved in the same direction, and no single group explains most of it.`; }
    else why = `Groups moved in different directions (${same} of ${contributors.length} with the overall direction).`;
    out.breakdown = {
      dimension: o.breakdownDimension, contributors: contributors.slice(0, o.topN ?? 12), pattern, patternExplanation: why,
      topContributorsShare: top2, movedInSameDirection: same, groupsCompared: contributors.length,
    };
    void concentration;
  }
  return out;
}
