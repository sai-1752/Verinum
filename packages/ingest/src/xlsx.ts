/**
 * .xlsx extraction. The container is first scanned with the bounded ZIP reader (zip-bomb guard);
 * cells are then read with ExcelJS's streaming reader so a large workbook never becomes an object
 * graph. Formulas are never evaluated — the cached result stored in the file is used, and a formula
 * without a cached result is read as blank (and counted). Macros are never executed or read.
 */
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { XMLParser } from "fast-xml-parser";
import type { RawCell } from "@verinum/core";
import { readZip } from "./safe-zip";
import { buildTable, tidyName } from "./tableutil";
import { IngestError, type ExtractedTable, type IngestLimits } from "./types";

interface SheetMeta { id: number; name: string; hidden: boolean }

function sheetMetas(bytes: Uint8Array, limits: IngestLimits): { metas: Map<number, SheetMeta>; hasComments: boolean } {
  const { entries } = readZip(bytes, limits, (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels");
  const wbXml = entries.get("xl/workbook.xml");
  const relXml = entries.get("xl/_rels/workbook.xml.rels");
  const metas = new Map<number, SheetMeta>();
  if (!wbXml) return { metas, hasComments: false };
  const xp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: false });
  const wb = xp.parse(new TextDecoder().decode(wbXml));
  const rels = relXml ? xp.parse(new TextDecoder().decode(relXml)) : null;
  const relTarget = new Map<string, string>();
  const relList = rels?.Relationships?.Relationship;
  for (const r of Array.isArray(relList) ? relList : relList ? [relList] : []) relTarget.set(r["@Id"], String(r["@Target"] ?? ""));
  const sheets = wb?.workbook?.sheets?.sheet;
  const list: Record<string, string>[] = Array.isArray(sheets) ? sheets : sheets ? [sheets] : [];
  list.forEach((s, i) => {
    const target = relTarget.get(s["@r:id"] ?? s["@id"] ?? "") ?? "";
    const m = /sheet(\d+)\.xml$/.exec(target);
    const id = m ? Number(m[1]) : i + 1;
    metas.set(id, { id, name: tidyName(String(s["@name"] ?? ""), `Sheet${id}`), hidden: s["@state"] === "hidden" || s["@state"] === "veryHidden" });
  });
  return { metas, hasComments: false };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Civil date from an Excel date cell. UTC getters on purpose: Excel dates carry no time zone. */
export function excelDateToString(d: Date): string {
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  return h || m || s ? `${date} ${pad(h)}:${pad(m)}:${pad(s)}` : date;
}

function cellValue(v: unknown, counters: { formulaNoCache: number; errors: number }): RawCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : excelDateToString(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("error" in o) { counters.errors++; return null; }
    if ("formula" in o || "sharedFormula" in o) {
      if (o.result === undefined || o.result === null) { counters.formulaNoCache++; return null; }
      return cellValue(o.result, counters);
    }
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    if (typeof o.text === "string") return o.text; // hyperlink cell
  }
  return String(v);
}

export async function extractXlsx(bytes: Uint8Array, limits: IngestLimits, macros: boolean, deadline: number): Promise<{ tables: ExtractedTable[]; warnings: string[] }> {
  const warnings: string[] = [];
  const { metas } = sheetMetas(bytes, limits); // also enforces the container limits
  if (macros) warnings.push("This workbook contains macros. They were ignored and never run.");

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]), {
    entries: "ignore", sharedStrings: "cache", hyperlinks: "ignore", styles: "cache", worksheets: "emit",
  });
  const tables: ExtractedTable[] = [];
  const counters = { formulaNoCache: 0, errors: 0 };
  let sheetIndex = 0;
  try {
    for await (const ws of reader as unknown as AsyncIterable<{ id: number; name: string; [Symbol.asyncIterator](): AsyncIterator<{ number: number; values: unknown[] }> }>) {
      const meta = metas.get(ws.id);
      sheetIndex++;
      if (sheetIndex > limits.maxSheets) { warnings.push(`Only the first ${limits.maxSheets} sheets were read.`); break; }
      const name = meta?.name ?? `Sheet${ws.id}`;
      const grid: RawCell[][] = [];
      let last = 0;
      for await (const row of ws) {
        if (Date.now() > deadline) throw new IngestError("timeout", "Reading the workbook took too long.");
        // keep row positions so blank rows between blocks stay blank
        while (last + 1 < row.number) { grid.push([]); last++; }
        const values = row.values as unknown[];
        const cells: RawCell[] = [];
        for (let c = 1; c < values.length; c++) cells.push(cellValue(values[c], counters));
        grid.push(cells);
        last = row.number;
        if (grid.length > limits.maxRows + 1000) { break; }
      }
      if (meta?.hidden) { warnings.push(`Sheet "${name}" is hidden and was skipped.`); continue; }
      const table = buildTable(grid.filter((r, i) => r.length > 0 || i === 0 ? true : false).filter((r) => r.length > 0), {
        name, source: { sheet: name, index: tables.length, kind: "sheet" }, limits,
      });
      if (table && (table.rows.length > 0 || table.columns.length > 0)) tables.push(table);
    }
  } catch (e) {
    if (e instanceof IngestError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) throw new IngestError("encrypted", "This workbook is password-protected.", "Remove the password and upload it again.");
    throw new IngestError("corrupt", "This Excel file is damaged or isn't a valid .xlsx workbook.");
  }
  if (counters.formulaNoCache) warnings.push(`${counters.formulaNoCache.toLocaleString("en-US")} formula cell${counters.formulaNoCache === 1 ? "" : "s"} had no stored result and were read as blank. Open and re-save the file in Excel to store results.`);
  if (counters.errors) warnings.push(`${counters.errors.toLocaleString("en-US")} cell${counters.errors === 1 ? "" : "s"} held Excel errors (such as #N/A) and were read as blank.`);
  return { tables, warnings };
}
