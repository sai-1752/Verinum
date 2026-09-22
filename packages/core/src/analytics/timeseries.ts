import { Frame, NULL_CODE, NULL_DATE, rowCountOf, type Column, type RowSet } from "../frame";
import { periodOrdinal, type Grain } from "../time";
import { AnalyticsError } from "./errors";
import { makePoint, type SeriesPoint, type TimeSeries } from "./periods";

export type SeriesAgg = "sum" | "avg" | "count" | "min" | "max" | "distinct_count";

export interface TimeSeriesOptions {
  dateColumn: string;
  metric?: string;
  agg?: SeriesAgg;
  grain: Grain;
}

const MAX_PERIODS = 200_000;

function keyOf(col: Column, i: number): number | null {
  switch (col.kind) {
    case "number": { const v = col.values[i]!; return v === v ? v : null; }
    case "date": return col.values[i] === NULL_DATE ? null : col.values[i]!;
    case "string": return col.codes[i] === NULL_CODE ? null : col.codes[i]!;
    case "boolean": return col.values[i] === 255 ? null : col.values[i]!;
  }
}

/** Buckets rows into calendar periods using civil-date arithmetic (timezone independent). */
export function buildTimeSeries(frame: Frame, rows: RowSet, o: TimeSeriesOptions): TimeSeries {
  const agg: SeriesAgg = o.agg ?? (o.metric ? "sum" : "count");
  const dcol = frame.get(o.dateColumn);
  if (!dcol) throw new AnalyticsError("unknown_column", `Column "${o.dateColumn}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
  if (dcol.kind !== "date") throw new AnalyticsError("wrong_type", `"${o.dateColumn}" is a ${dcol.kind} column, not a date.`);
  const mcol = o.metric ? frame.get(o.metric) : undefined;
  if (o.metric && !mcol) throw new AnalyticsError("unknown_column", `Column "${o.metric}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
  if ((agg === "sum" || agg === "avg" || agg === "min" || agg === "max") && (!mcol || mcol.kind !== "number")) {
    throw new AnalyticsError("wrong_type", `Aggregation "${agg}" needs a numeric metric column.`);
  }
  const total = rowCountOf(frame, rows);
  const dv = dcol.values;
  let minOrd = Infinity, maxOrd = -Infinity, minDay = Infinity, maxDay = -Infinity, noDate = 0;
  for (let k = 0; k < total; k++) {
    const d = dv[rows ? rows[k]! : k]!;
    if (d === NULL_DATE) { noDate++; continue; }
    if (d < minDay) minDay = d;
    if (d > maxDay) maxDay = d;
  }
  if (!Number.isFinite(minDay)) throw new AnalyticsError("insufficient_data", `"${o.dateColumn}" has no dates in the selected rows.`);
  minOrd = periodOrdinal(minDay, o.grain); maxOrd = periodOrdinal(maxDay, o.grain);
  const span = maxOrd - minOrd + 1;
  if (span > MAX_PERIODS) throw new AnalyticsError("too_many_groups", `A ${o.grain} grain would create ${span.toLocaleString("en-US")} periods; choose a coarser grain.`);

  const sums = new Float64Array(span), cnt = new Uint32Array(span);
  const mins = new Float64Array(span).fill(Infinity), maxs = new Float64Array(span).fill(-Infinity);
  const sets: Set<number>[] | null = agg === "distinct_count" ? Array.from({ length: span }, () => new Set<number>()) : null;
  const nv = mcol && mcol.kind === "number" ? mcol.values : null;
  let used = 0;
  for (let k = 0; k < total; k++) {
    const i = rows ? rows[k]! : k;
    const d = dv[i]!;
    if (d === NULL_DATE) continue;
    const p = periodOrdinal(d, o.grain) - minOrd;
    if (agg === "count") { if (mcol && keyOf(mcol, i) === null) continue; cnt[p]!++; sums[p]! += 1; used++; continue; }
    if (agg === "distinct_count") { const key = keyOf(mcol!, i); if (key === null) continue; sets![p]!.add(key); cnt[p]!++; used++; continue; }
    const v = nv![i]!;
    if (v !== v) continue;
    cnt[p]!++; sums[p]! += v; used++;
    if (v < mins[p]!) mins[p] = v;
    if (v > maxs[p]!) maxs[p] = v;
  }

  const points: SeriesPoint[] = [];
  const missing: number[] = [];
  for (let p = 0; p < span; p++) {
    if (!cnt[p]) { missing.push(minOrd + p); continue; }
    const value =
      agg === "sum" || agg === "count" ? sums[p]! :
      agg === "avg" ? sums[p]! / cnt[p]! :
      agg === "min" ? mins[p]! :
      agg === "max" ? maxs[p]! : sets![p]!.size;
    points.push(makePoint(minOrd + p, o.grain, cnt[p]!, value));
  }
  return {
    dateColumn: o.dateColumn, metric: o.metric ?? null, agg, grain: o.grain, points,
    missingOrdinals: missing, rowsUsed: used, rowsWithoutDate: noDate, minDay, maxDay,
  };
}
