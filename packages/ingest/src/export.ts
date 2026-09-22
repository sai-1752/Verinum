/**
 * Exports. Spreadsheet applications execute cells that start with = + - @ (and tab/CR) as formulas;
 * a value from an uploaded file such as "=HYPERLINK(...)" would run when the export is opened
 * ("CSV injection"). Text cells are prefixed with an apostrophe-style guard; real numbers are not.
 */
export interface ExportTable { columns: string[]; rows: (string | number | boolean | null)[][] }

const DANGEROUS = /^[=+\-@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export function escapeCsvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = String(v);
  if (DANGEROUS.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(t: ExportTable): string {
  const lines = [t.columns.map(escapeCsvCell).join(",")];
  for (const r of t.rows) lines.push(r.map(escapeCsvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Rows for XLSX/JSON export with the same guard applied to text cells. */
export function exportRows(t: ExportTable): { columns: string[]; rows: (string | number | boolean | null)[][] } {
  return {
    columns: t.columns.map((c) => guard(c) as string),
    rows: t.rows.map((r) => r.map((c) => (typeof c === "string" ? (guard(c) as string) : c))),
  };
}

function guard(s: string): string {
  return DANGEROUS.test(s) && !NUMERIC.test(s) ? `'${s}` : s;
}

/** XLSX bytes for a table (values only; text cells are formula-guarded). Uses SheetJS's writer, which never parses untrusted input. */
export async function toXlsx(t: ExportTable, sheetName = "Data"): Promise<Uint8Array> {
  const XLSX = (await import("xlsx")).default;
  const g = exportRows(t);
  const ws = XLSX.utils.aoa_to_sheet([g.columns, ...g.rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Data");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}
