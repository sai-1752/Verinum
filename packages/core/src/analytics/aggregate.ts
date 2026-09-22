import { Frame, NULL_CODE, NULL_DATE, rowCountOf, type Column, type RowSet } from "../frame";
import { quantileSorted } from "../stats";
import { AnalyticsError } from "./errors";

export type AggName = "sum" | "avg" | "count" | "distinct_count" | "min" | "max" | "median" | "std" | "percentile";

export const AGG_NAMES: readonly AggName[] = ["sum", "avg", "count", "distinct_count", "min", "max", "median", "std", "percentile"];

export interface AggResult {
  value: number | null;
  /** non-null values that contributed */
  n: number;
  /** rows considered (after filters) */
  rowsConsidered: number;
  /** rows in scope whose value was blank */
  blanks: number;
}

export function isAggName(s: string): s is AggName {
  return (AGG_NAMES as readonly string[]).includes(s);
}

/** Aggregates one column over a row set. count with no column = number of rows. */
export function aggregateColumn(frame: Frame, rows: RowSet, agg: AggName, column?: string, percentile = 50): AggResult {
  const total = rowCountOf(frame, rows);
  if (agg === "count" && !column) return { value: total, n: total, rowsConsidered: total, blanks: 0 };
  if (!column) throw new AnalyticsError("invalid_argument", `Aggregation "${agg}" needs a column.`);
  const col = frame.get(column);
  if (!col) throw new AnalyticsError("unknown_column", `Column "${column}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);

  if (agg === "count" || agg === "distinct_count") {
    let n = 0;
    const seen = new Set<number>();
    for (let k = 0; k < total; k++) {
      const i = rows ? rows[k]! : k;
      const v = rawKey(col, i);
      if (v === null) continue;
      n++;
      if (agg === "distinct_count") seen.add(v);
    }
    return { value: agg === "count" ? n : seen.size, n, rowsConsidered: total, blanks: total - n };
  }

  if (col.kind === "date" && (agg === "min" || agg === "max")) {
    let best = NaN, n = 0;
    for (let k = 0; k < total; k++) {
      const d = col.values[rows ? rows[k]! : k]!;
      if (d === NULL_DATE) continue;
      n++;
      if (Number.isNaN(best) || (agg === "min" ? d < best : d > best)) best = d;
    }
    return { value: n ? best : null, n, rowsConsidered: total, blanks: total - n };
  }
  if (col.kind !== "number") throw new AnalyticsError("wrong_type", `"${column}" is a ${col.kind} column; "${agg}" needs a numeric column.`);
  const vals = col.values;

  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (let k = 0; k < total; k++) {
    const v = vals[rows ? rows[k]! : k]!;
    if (v !== v) continue;
    n++; sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const blanks = total - n;
  if (!n) return { value: null, n: 0, rowsConsidered: total, blanks };
  switch (agg) {
    case "sum": return { value: sum, n, rowsConsidered: total, blanks };
    case "avg": return { value: sum / n, n, rowsConsidered: total, blanks };
    case "min": return { value: min, n, rowsConsidered: total, blanks };
    case "max": return { value: max, n, rowsConsidered: total, blanks };
    case "std": {
      if (n < 2) return { value: 0, n, rowsConsidered: total, blanks };
      const m = sum / n;
      let ss = 0;
      for (let k = 0; k < total; k++) { const v = vals[rows ? rows[k]! : k]!; if (v === v) ss += (v - m) ** 2; }
      return { value: Math.sqrt(ss / (n - 1)), n, rowsConsidered: total, blanks };
    }
    case "median":
    case "percentile": {
      const arr = new Float64Array(n);
      let j = 0;
      for (let k = 0; k < total; k++) { const v = vals[rows ? rows[k]! : k]!; if (v === v) arr[j++] = v; }
      arr.sort();
      const q = agg === "median" ? 0.5 : Math.min(1, Math.max(0, percentile / 100));
      return { value: quantileSorted(arr, q), n, rowsConsidered: total, blanks };
    }
  }
  return { value: null, n, rowsConsidered: total, blanks };
}

/** A numeric identity for cell i (used for distinct counting), or null when blank. */
function rawKey(col: Column, i: number): number | null {
  switch (col.kind) {
    case "number": { const v = col.values[i]!; return v === v ? v : null; }
    case "date": return col.values[i] === NULL_DATE ? null : col.values[i]!;
    case "string": return col.codes[i] === NULL_CODE ? null : col.codes[i]!;
    case "boolean": return col.values[i] === 255 ? null : col.values[i]!;
  }
}
