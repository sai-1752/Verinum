/** Row-level access for the data explorer and exports. Everything is read from the in-memory frame. */
import { allRows, cellValue, formatIsoDate, narrow, NULL_CODE, type AnalysisContext, type Column, type Filter, type Frame } from "@verinum/core";

export type Cell = string | number | boolean | null;

export interface RowQuery {
  filters?: Filter[];
  search?: string;
  sort?: { column: string; dir: "asc" | "desc" } | null;
  offset: number;
  limit: number;
  columns?: string[];
}

export interface RowPage {
  columns: { name: string; kind: Column["kind"] }[];
  rows: Cell[][];
  matched: number;
  total: number;
  offset: number;
  appliedFilters: string[];
}

export const displayCell = (c: Column, i: number): Cell => {
  const v = cellValue(c, i);
  return c.kind === "date" && typeof v === "number" ? formatIsoDate(v) : v;
};

/** Rows matching a free-text search: any string column containing the text (case-insensitive). */
function searchRows(frame: Frame, rows: Uint32Array | null, text: string): Uint32Array {
  const needle = text.trim().toLowerCase();
  const sets: { codes: Uint32Array; hit: Set<number> }[] = [];
  for (const c of frame.columns) {
    if (c.kind !== "string") continue;
    const hit = new Set<number>();
    c.dict.forEach((s, code) => { if (s.toLowerCase().includes(needle)) hit.add(code); });
    if (hit.size) sets.push({ codes: c.codes, hit });
  }
  const n = rows ? rows.length : frame.rowCount;
  const out = new Uint32Array(n);
  let m = 0;
  for (let k = 0; k < n; k++) {
    const i = rows ? rows[k]! : k;
    for (const s of sets) if (s.codes[i] !== NULL_CODE && s.hit.has(s.codes[i]!)) { out[m++] = i; break; }
  }
  return out.slice(0, m);
}

function sortRows(frame: Frame, rows: Uint32Array, column: string, dir: "asc" | "desc"): Uint32Array {
  const col = frame.require(column);
  const sign = dir === "asc" ? 1 : -1;
  const idx = Array.from(rows);
  // blanks always sort last, regardless of direction
  const key = (i: number): number | string | null => {
    switch (col.kind) {
      case "number": { const v = col.values[i]!; return Number.isNaN(v) ? null : v; }
      case "date": { const v = col.values[i]!; return v === -2147483648 ? null : v; }
      case "boolean": { const v = col.values[i]!; return v === 255 ? null : v; }
      case "string": return col.codes[i] === NULL_CODE ? null : col.dict[col.codes[i]!]!.toLowerCase();
    }
  };
  idx.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka === null || kb === null) return ka === kb ? a - b : ka === null ? 1 : -1;
    return ka < kb ? -sign : ka > kb ? sign : a - b;
  });
  return Uint32Array.from(idx);
}

export function queryRows(base: AnalysisContext, q: RowQuery): RowPage {
  const ctx = q.filters?.length ? narrow(base, q.filters) : base;
  let rows: Uint32Array = ctx.rows ?? allRows(ctx.frame.rowCount);
  if (q.search?.trim()) rows = searchRows(ctx.frame, rows, q.search);
  if (q.sort) rows = sortRows(ctx.frame, rows, q.sort.column, q.sort.dir);
  const cols = (q.columns?.length ? q.columns.map((n) => ctx.frame.require(n)) : ctx.frame.columns);
  const slice = rows.subarray(q.offset, q.offset + q.limit);
  const out: Cell[][] = new Array(slice.length);
  for (let k = 0; k < slice.length; k++) out[k] = cols.map((c) => displayCell(c, slice[k]!));
  return { columns: cols.map((c) => ({ name: c.name, kind: c.kind })), rows: out, matched: rows.length, total: base.frame.rowCount, offset: q.offset, appliedFilters: ctx.filterText };
}

/** All matching rows (for export), capped. */
export function allMatching(base: AnalysisContext, q: Pick<RowQuery, "filters" | "search" | "sort" | "columns">, cap: number): { columns: string[]; rows: Cell[][]; truncated: boolean; matched: number } {
  const page = queryRows(base, { ...q, offset: 0, limit: cap });
  return { columns: page.columns.map((c) => c.name), rows: page.rows, truncated: page.matched > cap, matched: page.matched };
}
