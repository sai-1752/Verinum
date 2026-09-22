import { Frame, cellValue, rowCountOf, type RowSet } from "../frame";
import { formatIsoDate } from "../time";
import { mad, numStats } from "../stats";
import { AnalyticsError } from "./errors";

export type OutlierMethod = "iqr" | "zscore" | "mad";

export interface OutlierExample {
  row: number;
  value: number;
  context: Record<string, string | number | null>;
}

export interface OutlierResult {
  column: string;
  method: OutlierMethod;
  thresholds: { low: number; high: number; description: string };
  count: number;
  countHigh: number;
  countLow: number;
  pctOfRows: number;
  rowsConsidered: number;
  valuesConsidered: number;
  stats: { q1: number; median: number; q3: number; mean: number; std: number };
  /** present only when row-level detail is permitted (never sent to the LLM by default) */
  examples?: OutlierExample[];
}

export function detectOutliers(
  frame: Frame, rows: RowSet, column: string,
  o: { method?: OutlierMethod; zThreshold?: number; examples?: number; contextColumns?: string[] } = {},
): OutlierResult {
  const col = frame.get(column);
  if (!col) throw new AnalyticsError("unknown_column", `Column "${column}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
  if (col.kind !== "number") throw new AnalyticsError("wrong_type", `"${column}" is a ${col.kind} column; outlier detection needs numbers.`);
  const method = o.method ?? "iqr";
  const total = rowCountOf(frame, rows);
  const vals = new Float64Array(total);
  let m = 0;
  for (let k = 0; k < total; k++) { const v = col.values[rows ? rows[k]! : k]!; if (v === v) vals[m++] = v; }
  const v = vals.subarray(0, m);
  if (m < 8) throw new AnalyticsError("insufficient_data", `"${column}" has only ${m} values; at least 8 are needed to look for outliers.`);
  const st = numStats(v);
  let low: number, high: number, description: string;
  if (method === "iqr") { low = st.fenceLow; high = st.fenceHigh; description = `1.5 × IQR fences (Q1 − 1.5·IQR, Q3 + 1.5·IQR)`; }
  else if (method === "zscore") {
    const z = o.zThreshold ?? 3; low = st.mean - z * st.std; high = st.mean + z * st.std; description = `mean ± ${z} standard deviations`;
  } else {
    const { med, mad: md } = mad(v);
    const s = 1.4826 * md || st.std; const z = o.zThreshold ?? 3.5;
    low = med - z * s; high = med + z * s; description = `median ± ${z} robust standard deviations (MAD)`;
  }
  let hi = 0, lo = 0;
  const hits: number[] = [];
  for (let k = 0; k < total; k++) {
    const i = rows ? rows[k]! : k;
    const x = col.values[i]!;
    if (x !== x) continue;
    if (x > high) { hi++; hits.push(i); } else if (x < low) { lo++; hits.push(i); }
  }
  const res: OutlierResult = {
    column, method, thresholds: { low, high, description }, count: hi + lo, countHigh: hi, countLow: lo,
    pctOfRows: (m ? ((hi + lo) / m) * 100 : 0), rowsConsidered: total, valuesConsidered: m,
    stats: { q1: st.q1, median: st.median, q3: st.q3, mean: st.mean, std: st.std },
  };
  if (o.examples && o.examples > 0) {
    const ctxCols = (o.contextColumns ?? []).filter((c) => frame.has(c) && c !== column);
    res.examples = hits
      .sort((a, b) => Math.abs(col.values[b]! - st.median) - Math.abs(col.values[a]! - st.median))
      .slice(0, o.examples)
      .map((i) => ({
        row: i, value: col.values[i]!,
        context: Object.fromEntries(ctxCols.map((c) => {
          const cc = frame.require(c);
          const cv = cellValue(cc, i);
          return [c, cc.kind === "date" && typeof cv === "number" ? formatIsoDate(cv) : (cv as string | number | null)];
        })),
      }));
  }
  return res;
}
