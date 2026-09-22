import { Frame, NULL_BOOL, NULL_CODE, NULL_DATE, rowCountOf, type Column, type RowSet } from "../frame";
import { periodKey, periodOrdinal, type Grain } from "../time";
import { quantileSorted } from "../stats";
import { AnalyticsError } from "./errors";
import { aggregateColumn, type AggName } from "./aggregate";

export const BLANK = "(blank)";

export interface GroupRow {
  key: string;
  isBlank: boolean;
  value: number;
  /** rows in the group that had a usable metric value */
  n: number;
  /** all rows in the group */
  rows: number;
  /** share of the total (%), only for additive aggregations (sum / count) */
  share: number | null;
  sum: number;
}

export interface GroupByOptions {
  dimension: string;
  metric?: string;
  agg?: AggName;
  percentile?: number;
  /** required when the dimension is a date column */
  grain?: Grain;
  limit?: number;
  order?: "desc" | "asc" | "key";
}

export interface GroupByResult {
  dimension: string;
  metric: string | null;
  agg: AggName;
  groups: GroupRow[];
  groupCount: number;
  /** sum of group values for sum/count; overall aggregate otherwise */
  total: number | null;
  shareIsMeaningful: boolean;
  rowsConsidered: number;
  blankRows: number;
}

export interface GroupIndex {
  count: number;
  labels: string[];
  /** group id per row, -1 never used (blank rows get the blank group when present) */
  of: Int32Array;
  blankGroup: number; // -1 when no blanks
}

/** Assigns every row to a group of `dimension`. Blank cells share one "(blank)" group. */
export function indexGroups(frame: Frame, col: Column, grain?: Grain): GroupIndex {
  const n = frame.rowCount;
  const of = new Int32Array(n);
  switch (col.kind) {
    case "string": {
      const g = col.dict.length;
      let hasBlank = false;
      for (let i = 0; i < n; i++) {
        const c = col.codes[i]!;
        if (c === NULL_CODE) { of[i] = g; hasBlank = true; } else of[i] = c;
      }
      return { count: hasBlank ? g + 1 : g, labels: hasBlank ? [...col.dict, BLANK] : col.dict, of, blankGroup: hasBlank ? g : -1 };
    }
    case "boolean": {
      let hasBlank = false;
      for (let i = 0; i < n; i++) {
        const v = col.values[i]!;
        if (v === NULL_BOOL) { of[i] = 2; hasBlank = true; } else of[i] = v;
      }
      return { count: hasBlank ? 3 : 2, labels: hasBlank ? ["false", "true", BLANK] : ["false", "true"], of, blankGroup: hasBlank ? 2 : -1 };
    }
    case "number": {
      const map = new Map<number, number>();
      const labels: string[] = [];
      let blank = -1;
      for (let i = 0; i < n; i++) {
        const v = col.values[i]!;
        if (v !== v) { if (blank < 0) { blank = labels.length; labels.push(BLANK); } of[i] = blank; continue; }
        let g = map.get(v);
        if (g === undefined) { g = labels.length; map.set(v, g); labels.push(String(v)); }
        of[i] = g;
        if (labels.length > 100000) throw new AnalyticsError("too_many_groups", `"${col.name}" has too many distinct values to group by.`);
      }
      return { count: labels.length, labels, of, blankGroup: blank };
    }
    case "date": {
      if (!grain) throw new AnalyticsError("invalid_argument", `Grouping by date column "${col.name}" needs a grain (day, week, month, quarter or year).`);
      const map = new Map<number, number>();
      const labels: string[] = [];
      let blank = -1;
      for (let i = 0; i < n; i++) {
        const d = col.values[i]!;
        if (d === NULL_DATE) { if (blank < 0) { blank = labels.length; labels.push(BLANK); } of[i] = blank; continue; }
        const ord = periodOrdinal(d, grain);
        let g = map.get(ord);
        if (g === undefined) { g = labels.length; map.set(ord, g); labels.push(periodKey(ord, grain)); }
        of[i] = g;
      }
      return { count: labels.length, labels, of, blankGroup: blank };
    }
  }
}

export function groupBy(frame: Frame, rows: RowSet, opts: GroupByOptions): GroupByResult {
  const agg: AggName = opts.agg ?? (opts.metric ? "sum" : "count");
  const dimCol = frame.get(opts.dimension);
  if (!dimCol) throw new AnalyticsError("unknown_column", `Column "${opts.dimension}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
  const metricCol = opts.metric ? frame.get(opts.metric) : undefined;
  if (opts.metric && !metricCol) throw new AnalyticsError("unknown_column", `Column "${opts.metric}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
  const needsNumber = agg !== "count" && agg !== "distinct_count";
  if (needsNumber && (!metricCol || metricCol.kind !== "number")) {
    throw new AnalyticsError("wrong_type", `Aggregation "${agg}" needs a numeric metric column${opts.metric ? `; "${opts.metric}" is ${metricCol?.kind}` : ""}.`);
  }

  const gi = indexGroups(frame, dimCol, opts.grain);
  const G = gi.count;
  const rowsIn = new Uint32Array(G), nUsed = new Uint32Array(G);
  const sums = new Float64Array(G);
  const mins = new Float64Array(G).fill(Infinity), maxs = new Float64Array(G).fill(-Infinity);
  const keep = agg === "median" || agg === "percentile" || agg === "std";
  const lists: number[][] | null = keep ? Array.from({ length: G }, () => []) : null;
  const distinct: Set<number>[] | null = agg === "distinct_count" ? Array.from({ length: G }, () => new Set<number>()) : null;

  const total = rowCountOf(frame, rows);
  const numVals = metricCol && metricCol.kind === "number" ? metricCol.values : null;
  for (let k = 0; k < total; k++) {
    const i = rows ? rows[k]! : k;
    const g = gi.of[i]!;
    rowsIn[g]!++;
    if (agg === "count" && !metricCol) { nUsed[g]!++; sums[g]! += 1; continue; }
    if (distinct && metricCol) {
      const key = keyOf(metricCol, i);
      if (key !== null) { distinct[g]!.add(key); nUsed[g]!++; }
      continue;
    }
    if (agg === "count" && metricCol) {
      if (keyOf(metricCol, i) !== null) { nUsed[g]!++; sums[g]! += 1; }
      continue;
    }
    const v = numVals![i]!;
    if (v !== v) continue;
    nUsed[g]!++; sums[g]! += v;
    if (v < mins[g]!) mins[g] = v;
    if (v > maxs[g]!) maxs[g] = v;
    if (lists) lists[g]!.push(v);
  }

  const out: GroupRow[] = [];
  for (let g = 0; g < G; g++) {
    if (!rowsIn[g]) continue;
    let value: number;
    switch (agg) {
      case "count": value = sums[g]!; break;
      case "distinct_count": value = distinct![g]!.size; break;
      case "sum": value = sums[g]!; break;
      case "avg": if (!nUsed[g]) continue; value = sums[g]! / nUsed[g]!; break;
      case "min": if (!nUsed[g]) continue; value = mins[g]!; break;
      case "max": if (!nUsed[g]) continue; value = maxs[g]!; break;
      case "median": case "percentile": {
        if (!nUsed[g]) continue;
        const arr = Float64Array.from(lists![g]!).sort();
        value = quantileSorted(arr, agg === "median" ? 0.5 : Math.min(1, Math.max(0, (opts.percentile ?? 50) / 100)));
        break;
      }
      case "std": {
        if (nUsed[g]! < 2) { value = 0; break; }
        const arr = lists![g]!;
        const m = sums[g]! / nUsed[g]!;
        let ss = 0; for (const x of arr) ss += (x - m) ** 2;
        value = Math.sqrt(ss / (nUsed[g]! - 1));
        break;
      }
    }
    out.push({ key: gi.labels[g]!, isBlank: g === gi.blankGroup, value, n: nUsed[g]!, rows: rowsIn[g]!, share: null, sum: sums[g]! });
  }

  const additive = agg === "sum" || agg === "count";
  const order = opts.order ?? "desc";
  if (order === "key") out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else out.sort((a, b) => (order === "desc" ? b.value - a.value : a.value - b.value) || (a.key < b.key ? -1 : 1));

  let totalValue: number | null = null;
  if (additive) {
    totalValue = out.reduce((s, r) => s + r.value, 0);
    for (const r of out) r.share = totalValue !== 0 ? (r.value / totalValue) * 100 : 0;
  } else {
    totalValue = aggregateColumn(frame, rows, agg, opts.metric, opts.percentile).value;
  }
  const blank = out.find((r) => r.isBlank);
  return {
    dimension: opts.dimension, metric: opts.metric ?? null, agg,
    groups: opts.limit ? out.slice(0, opts.limit) : out,
    groupCount: out.length, total: totalValue, shareIsMeaningful: additive,
    rowsConsidered: total, blankRows: blank ? blank.rows : 0,
  };
}

function keyOf(col: Column, i: number): number | null {
  switch (col.kind) {
    case "number": { const v = col.values[i]!; return v === v ? v : null; }
    case "date": return col.values[i] === NULL_DATE ? null : col.values[i]!;
    case "string": return col.codes[i] === NULL_CODE ? null : col.codes[i]!;
    case "boolean": return col.values[i] === NULL_BOOL ? null : col.values[i]!;
  }
}

/* ------------------------------ two-way cross tab --------------------------- */

export interface CrossCell { a: string; b: string; value: number; n: number }
export interface CrossTabResult {
  dimensionA: string; dimensionB: string; metric: string | null; agg: AggName;
  aLabels: string[]; bLabels: string[]; cells: CrossCell[]; cellCount: number; rowsConsidered: number;
}

export function crossTab(
  frame: Frame, rows: RowSet,
  opts: { dimensionA: string; dimensionB: string; metric?: string; agg?: "sum" | "avg" | "count"; maxLabels?: number },
): CrossTabResult {
  const agg = opts.agg ?? (opts.metric ? "sum" : "count");
  const ca = frame.require(opts.dimensionA), cb = frame.require(opts.dimensionB);
  const mc = opts.metric ? frame.number(opts.metric) : null;
  if (agg !== "count" && !mc) throw new AnalyticsError("invalid_argument", `Aggregation "${agg}" needs a numeric metric.`);
  const ga = indexGroups(frame, ca), gb = indexGroups(frame, cb);
  const sums = new Map<number, { s: number; n: number }>();
  const totalA = new Float64Array(ga.count), totalB = new Float64Array(gb.count);
  const total = rowCountOf(frame, rows);
  for (let k = 0; k < total; k++) {
    const i = rows ? rows[k]! : k;
    const v = mc ? mc.values[i]! : 1;
    if (v !== v) continue;
    const a = ga.of[i]!, b = gb.of[i]!;
    const key = a * gb.count + b;
    const e = sums.get(key);
    if (e) { e.s += v; e.n++; } else sums.set(key, { s: v, n: 1 });
    totalA[a]! += Math.abs(v); totalB[b]! += Math.abs(v);
  }
  const maxL = opts.maxLabels ?? 12;
  const top = (t: Float64Array) => [...t.keys()].sort((x, y) => t[y]! - t[x]!).slice(0, maxL);
  const keepA = new Set(top(totalA)), keepB = new Set(top(totalB));
  const cells: CrossCell[] = [];
  for (const [key, e] of sums) {
    const a = Math.floor(key / gb.count), b = key % gb.count;
    if (!keepA.has(a) || !keepB.has(b)) continue;
    cells.push({ a: ga.labels[a]!, b: gb.labels[b]!, value: agg === "avg" ? e.s / e.n : e.s, n: e.n });
  }
  cells.sort((x, y) => y.value - x.value);
  return {
    dimensionA: opts.dimensionA, dimensionB: opts.dimensionB, metric: opts.metric ?? null, agg,
    aLabels: [...keepA].map((i) => ga.labels[i]!), bLabels: [...keepB].map((i) => gb.labels[i]!),
    cells, cellCount: cells.length, rowsConsidered: total,
  };
}
