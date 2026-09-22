/**
 * Ingestion entry point: bytes + filename → one or more tables (plus a structured document for
 * PDF/DOCX/HTML/text). Format is decided from file contents; every limit is enforced; nothing is
 * executed. This function is CPU-bound — the API runs it inside a worker thread (see runner.ts).
 */
import type { RawCell } from "@verinum/core";
import { decodeText } from "./encoding";
import { detectDelimiter, parseDelimited } from "./delimited";
import { detectFixedWidth } from "./fixedwidth";
import { parseJsonText } from "./json";
import { parseXmlRecords } from "./xml";
import { parseHtml } from "./html";
import { extractXlsx } from "./xlsx";
import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { readXlsSandboxed } from "./sandbox";
import { blocksFromText, buildDocument } from "./document";
import { buildTable, tidyName } from "./tableutil";
import { extensionOf, sniffFormat } from "./sniff";
import { DEFAULT_LIMITS, IngestError, type DetectedFormat, type DocBlock, type ExtractedTable, type IngestLimits, type IngestResult, type StructuredDocument } from "./types";

export * from "./types";
export { sniffFormat } from "./sniff";
export { decodeText } from "./encoding";
export { toCsv, toXlsx, escapeCsvCell, exportRows, type ExportTable } from "./export";
export { ingestInWorker } from "./runner";

export interface IngestOptions {
  filename: string;
  limits?: Partial<IngestLimits>;
  xlsWorkerUrl?: URL;
}

const SUPPORTED = "CSV, TSV, Excel (.xlsx/.xls), JSON, XML, HTML, PDF, Word (.docx), plain text and fixed-width files";

export async function ingestFile(bytes: Uint8Array, opts: IngestOptions): Promise<IngestResult> {
  const t0 = Date.now();
  const limits: IngestLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const deadline = t0 + limits.timeoutMs;
  if (bytes.length > limits.maxBytes) {
    throw new IngestError("too_large", `This file is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${(limits.maxBytes / 1048576).toFixed(0)} MB.`, "Upload a smaller file or split it.");
  }
  const sniffed = sniffFormat(bytes, opts.filename, limits);
  if (sniffed.format === "zip_other") throw new IngestError("unsupported_format", "ZIP archives aren't supported.", `Unzip the file and upload the document inside. Supported: ${SUPPORTED}.`);

  const warnings: string[] = [];
  const base = { formatReason: sniffed.reason, warnings };
  const done = (format: DetectedFormat, tables: ExtractedTable[], extra: Partial<IngestResult> = {}): IngestResult => {
    if (!tables.length) throw new IngestError("no_tables", "No table of data was found in this file.", extra.document ? "The file has text but no rows and columns. Upload a spreadsheet or CSV, or paste the table into one." : undefined);
    const ext = extensionOf(opts.filename);
    if ((format === "csv" && ext && !["csv", "txt", "tsv", "tab", "dat", ""].includes(ext)) || (["xlsx", "xls", "pdf", "docx", "json", "xml", "html"].includes(format) && ext && ext !== format && !(format === "html" && ext === "htm") && !(format === "xlsx" && ext === "xlsm"))) {
      warnings.push(`The file's extension (.${ext}) doesn't match its contents (${format.toUpperCase()}); it was read as ${format.toUpperCase()}.`);
    }
    return { format, ...base, tables, warnings, stats: { bytes: bytes.length, ms: Date.now() - t0 }, ...extra };
  };

  switch (sniffed.format) {
    case "xlsx": {
      const r = await extractXlsx(bytes, limits, !!sniffed.macros, deadline);
      warnings.push(...r.warnings);
      return done("xlsx", r.tables);
    }
    case "xls": {
      const r = await readXlsSandboxed(bytes, limits, opts.xlsWorkerUrl);
      const tables: ExtractedTable[] = [];
      for (const s of r.sheets) {
        if (s.hidden) { warnings.push(`Sheet "${s.name}" is hidden and was skipped.`); continue; }
        const t = buildTable(s.grid, { name: tidyName(s.name, `Sheet ${tables.length + 1}`), source: { sheet: s.name, index: tables.length, kind: "sheet" }, limits });
        if (t) tables.push(t);
      }
      if (r.truncated) warnings.push("Some rows or columns beyond the limits were not read.");
      return done("xls", tables);
    }
    case "pdf": {
      const r = await extractPdf(bytes, limits, deadline);
      warnings.push(...r.warnings);
      return documentResult("pdf", r.blocks, r.tables.map((t) => ({ grid: t.grid, page: t.page })), r.pages, limits, done);
    }
    case "docx": {
      const r = extractDocx(bytes, limits);
      warnings.push(...r.warnings);
      return documentResult("docx", r.blocks, r.tables.map((g) => ({ grid: g })), undefined, limits, done);
    }
    default:
      break;
  }

  // ---- text formats ----
  const { text, encoding } = decodeText(bytes);
  if (encoding !== "utf-8") warnings.push(`The text was read as ${encoding.toUpperCase()}.`);
  const withEnc = (r: IngestResult) => ({ ...r, encoding });

  switch (sniffed.format) {
    case "json": case "ndjson": {
      const r = parseJsonText(text, limits, sniffed.format === "ndjson");
      const t = buildTable(r.grid, { name: tidyName(opts.filename.replace(/\.[^.]+$/, ""), "data"), source: { index: 0, kind: "records" }, limits, header: true, notes: r.notes });
      return withEnc(done(sniffed.format, t ? [t] : []));
    }
    case "xml": {
      const r = parseXmlRecords(text, limits);
      const t = buildTable(r.grid, { name: tidyName(opts.filename.replace(/\.[^.]+$/, ""), "data"), source: { index: 0, kind: "records" }, limits, header: true, notes: r.notes });
      return withEnc(done("xml", t ? [t] : []));
    }
    case "html": {
      const r = parseHtml(text, limits);
      warnings.push(...r.warnings);
      return withEnc(await documentResult("html", r.blocks, r.tables.map((t) => ({ grid: t.grid, name: t.name, header: t.hasHeaderRow ? true : ("detect" as const) })), undefined, limits, done));
    }
    default: {
      // csv / tsv / txt: delimited → fixed width → prose
      const ext = extensionOf(opts.filename);
      const preferred = ext === "tsv" || ext === "tab" ? "\t" : ext === "csv" ? "," : undefined;
      const guess = detectDelimiter(text, preferred);
      if (guess) {
        const { grid, warnings: w } = parseDelimited(text, guess.delimiter, limits);
        warnings.push(...w);
        const fmt: DetectedFormat = guess.delimiter === "," ? "csv" : guess.delimiter === "\t" ? "tsv" : "delimited";
        const t = buildTable(grid, { name: tidyName(opts.filename.replace(/\.[^.]+$/, ""), "data"), source: { index: 0, kind: "file" }, limits });
        return withEnc(done(fmt, t ? [t] : [], { delimiter: guess.delimiter }));
      }
      const fw = detectFixedWidth(text);
      if (fw) {
        const t = buildTable(fw.grid, { name: tidyName(opts.filename.replace(/\.[^.]+$/, ""), "data"), source: { index: 0, kind: "file" }, limits, notes: [`Columns were inferred from the aligned text layout (${fw.columns} columns).`] });
        return withEnc(done("fixed_width", t ? [t] : []));
      }
      const blocks = blocksFromText(text);
      return withEnc(await documentResult("txt", blocks, [], undefined, limits, done));
    }
  }
}

type TableIn = { grid: RawCell[][]; page?: number; name?: string; header?: boolean | "detect" };

/** Shared tail for document-like formats: tables become datasets; text becomes a structured document. */
async function documentResult(
  format: DetectedFormat, blocks: DocBlock[], tablesIn: TableIn[], pages: number | undefined, limits: IngestLimits,
  done: (f: DetectedFormat, t: ExtractedTable[], extra?: Partial<IngestResult>) => IngestResult,
): Promise<IngestResult> {
  const tables: ExtractedTable[] = [];
  const remap = new Map<number, number>();
  tablesIn.forEach((t, i) => {
    const name = t.name ?? `Table ${i + 1}${t.page ? ` (page ${t.page})` : ""}`;
    const et = buildTable(t.grid, { name: tidyName(name, `Table ${i + 1}`), source: { index: tables.length, kind: "table", page: t.page }, limits, header: t.header ?? "detect", notes: [t.page ? `Found on page ${t.page}.` : "Found in the document."] });
    if (et && et.rows.length) { remap.set(i, tables.length); tables.push(et); }
  });
  const fixed: DocBlock[] = blocks.flatMap((b): DocBlock[] => (b.type === "table" ? (remap.has(b.tableIndex) ? [{ ...b, tableIndex: remap.get(b.tableIndex)! }] : []) : [b]));
  const document: StructuredDocument = buildDocument(fixed, pages);
  if (!tables.length) {
    // nothing tabular: still expose the text so it can be explored, and say plainly what it is
    const paras = fixed.filter((b): b is Extract<DocBlock, { type: "paragraph" | "heading" }> => b.type !== "table");
    if (paras.length >= 1) {
      let section = "";
      const grid: RawCell[][] = [["section", "paragraph", "text"]];
      paras.forEach((b, i) => {
        if (b.type === "heading") { section = b.text; return; }
        grid.push([section, i + 1, b.text]);
      });
      const t = buildTable(grid, { name: "Document text", source: { index: 0, kind: "text" }, limits, header: true, notes: ["No tables were found, so the document's paragraphs were listed as rows. Numeric analysis isn't possible on this data."] });
      if (t && t.rows.length) return done(format, [t], { document });
    }
  }
  return done(format, tables, { document });
}
