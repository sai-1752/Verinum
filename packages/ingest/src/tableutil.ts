import type { RawCell } from "@verinum/core";
import type { ExtractedTable, IngestLimits, TableSource } from "./types";

const isBlank = (c: RawCell) => c === null || c === undefined || (typeof c === "string" && c.trim() === "");
const isNumberLike = (c: RawCell) => typeof c === "number" || (typeof c === "string" && /^[-+(]?[$€£¥]?\s*\d[\d,.\s]*%?\)?$/.test(c.trim()));

export interface BuildOptions {
  name: string;
  source: TableSource;
  limits: IngestLimits;
  /** rows include a header row (default: detect) */
  header?: boolean | "detect";
  notes?: string[];
}

/**
 * Turns a raw grid into a table: finds the header row (skipping title/metadata lines above it),
 * drops fully-empty trailing columns, enforces row/column/cell limits and reports what it did.
 */
export function buildTable(grid: RawCell[][], o: BuildOptions): ExtractedTable | null {
  const notes = [...(o.notes ?? [])];
  let rows = grid.filter((r) => r.length > 0);
  if (rows.length === 0) return null;

  // 1. leading metadata rows: skip rows until one is "dense" (≥60% of the widest non-empty width) and the next row is too
  const width = Math.max(...rows.slice(0, 200).map((r) => lastNonBlank(r) + 1));
  let start = 0;
  if (o.header !== false) {
    const dense = (r: RawCell[] | undefined) => !!r && r.filter((c) => !isBlank(c)).length >= Math.max(2, Math.ceil(width * 0.6));
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      if (dense(rows[i]) && (dense(rows[i + 1]) || i + 1 >= rows.length)) { start = i; break; }
      if (i === Math.min(rows.length, 30) - 1) start = 0;
    }
    if (start > 0) { notes.push(`Skipped ${start} title or notes row${start === 1 ? "" : "s"} above the header.`); rows = rows.slice(start); }
  }

  // 2. header detection
  let hasHeader = o.header === true;
  if (o.header === undefined || o.header === "detect") {
    const first = rows[0]!, second = rows[1];
    const firstNumeric = first.filter((c) => !isBlank(c)).filter(isNumberLike).length;
    const firstFilled = first.filter((c) => !isBlank(c)).length;
    const secondNumeric = second ? second.filter((c) => !isBlank(c)).filter(isNumberLike).length : 0;
    hasHeader = !(firstFilled > 0 && firstNumeric / firstFilled > 0.8 && secondNumeric > 0);
    if (!hasHeader) notes.push("No header row was found, so columns were named column_1, column_2, …");
  }
  const w = Math.max(...rows.slice(0, 1000).map((r) => lastNonBlank(r) + 1), 1);
  let columns: string[];
  let body: RawCell[][];
  if (hasHeader) {
    columns = Array.from({ length: w }, (_, i) => (isBlank(rows[0]![i]) ? "" : String(rows[0]![i]).trim()));
    body = rows.slice(1);
  } else {
    columns = Array.from({ length: w }, (_, i) => `column_${i + 1}`);
    body = rows;
  }

  // 3. column cap
  let truncated = false;
  let cols = columns.length;
  if (cols > o.limits.maxColumns) {
    notes.push(`Only the first ${o.limits.maxColumns} of ${cols} columns were read.`);
    cols = o.limits.maxColumns;
    columns = columns.slice(0, cols);
    truncated = true;
  }
  // 4. row cap + cell length cap + rectangularise
  if (body.length > o.limits.maxRows) {
    notes.push(`Only the first ${o.limits.maxRows.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} rows were read.`);
    body = body.slice(0, o.limits.maxRows);
    truncated = true;
  }
  let clipped = 0;
  const out: RawCell[][] = new Array(body.length);
  for (let i = 0; i < body.length; i++) {
    const src = body[i]!;
    const row: RawCell[] = new Array(cols);
    for (let j = 0; j < cols; j++) {
      let v = src[j];
      if (typeof v === "string" && v.length > o.limits.maxCellChars) { v = v.slice(0, o.limits.maxCellChars); clipped++; }
      row[j] = v === undefined ? null : v;
    }
    out[i] = row;
  }
  if (clipped) notes.push(`${clipped.toLocaleString("en-US")} cell${clipped === 1 ? " was" : "s were"} longer than ${o.limits.maxCellChars.toLocaleString("en-US")} characters and were shortened.`);
  if (out.length === 0 && columns.every((c) => c === "")) return null;
  return { name: o.name, columns, rows: out, source: o.source, notes, truncated };
}

function lastNonBlank(r: RawCell[]): number {
  for (let i = r.length - 1; i >= 0; i--) if (!isBlank(r[i])) return i;
  return -1;
}

/** Sanitises a sheet/table name for display. */
export const tidyName = (s: string, fallback: string) => {
  const t = s.replace(/\s+/g, " ").trim().slice(0, 80);
  return t || fallback;
};
