import { Frame, NULL_BOOL, NULL_CODE, NULL_DATE, type Column, type RowSet, type StringColumn } from "../frame";
import { daysFromCivil, formatIsoDate, parseIsoDate } from "../time";
import { parseBoolToken, parseNumberCell } from "../values";
import { AnalyticsError } from "./errors";

export type FilterOp =
  | "eq" | "neq" | "in" | "not_in" | "contains" | "gt" | "gte" | "lt" | "lte" | "between" | "is_null" | "not_null";

export type FilterValue = string | number | boolean;

export interface Filter {
  column: string;
  op: FilterOp;
  value?: FilterValue | null;
  /** for in / not_in / between (two values) */
  values?: FilterValue[];
}

export interface FilterResult {
  rows: Uint32Array;
  matched: number;
  total: number;
  /** filters whose value matched nothing in the column, with the closest existing values */
  warnings: string[];
}

/** [startDay, endDay] for an ISO date, "YYYY-MM", "YYYY-Qn" or "YYYY" key. */
export function dateRangeFromKey(key: string): [number, number] | null {
  const s = String(key).trim();
  const iso = parseIsoDate(s);
  if (iso !== null) return [iso, iso];
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m && +m[2]! >= 1 && +m[2]! <= 12) {
    const y = +m[1]!, mo = +m[2]!;
    return [daysFromCivil(y, mo, 1), (mo === 12 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, mo + 1, 1)) - 1];
  }
  m = /^(\d{4})-Q([1-4])$/i.exec(s);
  if (m) {
    const y = +m[1]!, q = +m[2]!;
    return [daysFromCivil(y, (q - 1) * 3 + 1, 1), (q === 4 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, q * 3 + 1, 1)) - 1];
  }
  m = /^(\d{4})$/.exec(s);
  if (m) return [daysFromCivil(+m[1]!, 1, 1), daysFromCivil(+m[1]! + 1, 1, 1) - 1];
  return null;
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = i - 1;
    prev[0] = i;
    let rowMin = prev[0]!;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
      rowMin = Math.min(rowMin, prev[j]!);
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length]!;
}

/** Closest dictionary values to `value` (substring first, then small edit distance). */
export function closestValues(col: StringColumn, value: string, k = 5): string[] {
  const v = value.toLowerCase();
  const scored: { s: string; score: number }[] = [];
  for (const d of col.dict) {
    const dl = d.toLowerCase();
    if (dl.includes(v) || v.includes(dl)) scored.push({ s: d, score: 0 });
    else {
      const dist = levenshtein(dl, v, 3);
      if (dist <= 3) scored.push({ s: d, score: dist });
    }
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, k).map((x) => x.s);
}

type Pred = (i: number) => boolean;

function valuesOf(f: Filter): FilterValue[] {
  if (f.values && f.values.length) return f.values;
  if (f.value !== undefined && f.value !== null) return [f.value];
  return [];
}

function buildPredicate(col: Column, f: Filter, warnings: string[]): Pred {
  const op = f.op;
  if (op === "is_null" || op === "not_null") {
    const want = op === "is_null";
    switch (col.kind) {
      case "number": return (i) => Number.isNaN(col.values[i]!) === want;
      case "date": return (i) => (col.values[i] === NULL_DATE) === want;
      case "string": return (i) => (col.codes[i] === NULL_CODE) === want;
      case "boolean": return (i) => (col.values[i] === NULL_BOOL) === want;
    }
  }
  const vals = valuesOf(f);
  if (!vals.length) throw new AnalyticsError("invalid_argument", `Filter on "${col.name}" with operator "${op}" needs a value.`);

  switch (col.kind) {
    case "string": {
      const lower = vals.map((v) => String(v).toLowerCase());
      if (op === "contains") {
        const hit = new Uint8Array(col.dict.length);
        col.dict.forEach((d, c) => { const dl = d.toLowerCase(); if (lower.some((l) => dl.includes(l))) hit[c] = 1; });
        if (!hit.some((x) => x)) warnings.push(`No value in "${col.name}" contains ${vals.map((v) => `"${v}"`).join(" or ")}.`);
        return (i) => col.codes[i] !== NULL_CODE && hit[col.codes[i]!] === 1;
      }
      if (op === "eq" || op === "neq" || op === "in" || op === "not_in") {
        const set = new Set(lower);
        const hit = new Uint8Array(col.dict.length);
        let any = false;
        col.dict.forEach((d, c) => { if (set.has(d.toLowerCase())) { hit[c] = 1; any = true; } });
        if (!any) {
          const near = vals.flatMap((v) => closestValues(col, String(v), 3));
          warnings.push(`"${vals.join('", "')}" does not appear in "${col.name}".${near.length ? ` Closest existing values: ${[...new Set(near)].map((x) => `"${x}"`).join(", ")}.` : ""}`);
        }
        const positive = op === "eq" || op === "in";
        return (i) => { const c = col.codes[i]!; return c !== NULL_CODE && (hit[c] === 1) === positive; };
      }
      throw new AnalyticsError("invalid_argument", `Operator "${op}" is not valid for text column "${col.name}". Use eq, neq, in, not_in or contains.`);
    }
    case "number": {
      const nums = vals.map((v) => (typeof v === "number" ? v : parseNumberCell(String(v))?.value ?? NaN));
      if (nums.some((n) => Number.isNaN(n))) throw new AnalyticsError("invalid_argument", `Filter value for numeric column "${col.name}" must be a number.`);
      const a = nums[0]!;
      switch (op) {
        case "eq": return (i) => col.values[i] === a;
        case "neq": return (i) => { const v = col.values[i]!; return v === v && v !== a; };
        case "in": { const s = new Set(nums); return (i) => s.has(col.values[i]!); }
        case "not_in": { const s = new Set(nums); return (i) => { const v = col.values[i]!; return v === v && !s.has(v); }; }
        case "gt": return (i) => col.values[i]! > a;
        case "gte": return (i) => col.values[i]! >= a;
        case "lt": return (i) => col.values[i]! < a;
        case "lte": return (i) => col.values[i]! <= a;
        case "between": {
          if (nums.length < 2) throw new AnalyticsError("invalid_argument", `"between" needs two values.`);
          const lo = Math.min(nums[0]!, nums[1]!), hi = Math.max(nums[0]!, nums[1]!);
          return (i) => col.values[i]! >= lo && col.values[i]! <= hi;
        }
        default: throw new AnalyticsError("invalid_argument", `Operator "${op}" is not valid for numeric column "${col.name}".`);
      }
    }
    case "date": {
      const ranges = vals.map((v) => dateRangeFromKey(String(v)));
      if (ranges.some((r) => !r)) throw new AnalyticsError("invalid_argument", `Filter value for date column "${col.name}" must be an ISO date (2025-03-31), month (2025-03), quarter (2025-Q1) or year (2025).`);
      const r0 = ranges[0]!;
      switch (op) {
        case "eq": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && d >= r0[0] && d <= r0[1]; };
        case "neq": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && (d < r0[0] || d > r0[1]); };
        case "in": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && ranges.some((r) => d >= r![0] && d <= r![1]); };
        case "not_in": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && !ranges.some((r) => d >= r![0] && d <= r![1]); };
        case "gte": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && d >= r0[0]; };
        case "gt": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && d > r0[1]; };
        case "lt": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && d < r0[0]; };
        case "lte": return (i) => { const d = col.values[i]!; return d !== NULL_DATE && d <= r0[1]; };
        case "between": {
          if (ranges.length < 2) throw new AnalyticsError("invalid_argument", `"between" needs two values.`);
          const lo = Math.min(ranges[0]![0], ranges[1]![0]), hi = Math.max(ranges[0]![1], ranges[1]![1]);
          return (i) => { const d = col.values[i]!; return d !== NULL_DATE && d >= lo && d <= hi; };
        }
        default: throw new AnalyticsError("invalid_argument", `Operator "${op}" is not valid for date column "${col.name}".`);
      }
    }
    case "boolean": {
      const b = parseBoolToken(vals[0]);
      if (b === null) throw new AnalyticsError("invalid_argument", `Filter value for boolean column "${col.name}" must be true/false or yes/no.`);
      if (op === "eq") return (i) => col.values[i] === b;
      if (op === "neq") return (i) => col.values[i] !== NULL_BOOL && col.values[i] !== b;
      throw new AnalyticsError("invalid_argument", `Operator "${op}" is not valid for boolean column "${col.name}".`);
    }
  }
}

/** AND-combines filters over `base` (or all rows). Throws AnalyticsError on bad columns/values. */
export function applyFilters(frame: Frame, filters: Filter[], base: RowSet = null): FilterResult {
  const warnings: string[] = [];
  const preds: Pred[] = filters.map((f) => {
    const col = frame.get(f.column);
    if (!col) throw new AnalyticsError("unknown_column", `Column "${f.column}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
    return buildPredicate(col, f, warnings);
  });
  const total = base ? base.length : frame.rowCount;
  const out = new Uint32Array(total);
  let m = 0;
  for (let k = 0; k < total; k++) {
    const i = base ? base[k]! : k;
    let ok = true;
    for (let p = 0; p < preds.length; p++) if (!preds[p]!(i)) { ok = false; break; }
    if (ok) out[m++] = i;
  }
  return { rows: out.slice(0, m), matched: m, total, warnings };
}

/** Human-readable description of a filter for provenance / UI. */
export function describeFilter(f: Filter): string {
  const v = valuesOf(f);
  switch (f.op) {
    case "is_null": return `${f.column} is blank`;
    case "not_null": return `${f.column} is not blank`;
    case "between": return `${f.column} between ${v[0]} and ${v[1]}`;
    case "in": return `${f.column} in (${v.join(", ")})`;
    case "not_in": return `${f.column} not in (${v.join(", ")})`;
    default: return `${f.column} ${{ eq: "=", neq: "≠", contains: "contains", gt: ">", gte: "≥", lt: "<", lte: "≤" }[f.op as string]} ${v[0]}`;
  }
}

export { formatIsoDate };
