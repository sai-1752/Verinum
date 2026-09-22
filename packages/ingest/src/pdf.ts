/**
 * PDF extraction with pdf.js (text layer only — no scripting, no rendering, no font loading).
 * Text items are grouped into lines by baseline, lines into cells by horizontal gaps, and runs of
 * lines whose cells line up in columns become tables. Scanned (image-only) PDFs have no text layer:
 * that is reported instead of returning nothing silently.
 */
import type { RawCell } from "@verinum/core";
import { IngestError, type DocBlock, type IngestLimits } from "./types";

interface Item { str: string; x: number; y: number; w: number; h: number }
interface Line { y: number; cells: { text: string; x0: number; x1: number }[]; text: string }

export interface PdfResult { blocks: DocBlock[]; tables: { page: number; grid: RawCell[][] }[]; pages: number; warnings: string[] }

const isNum = (s: string) => /^[-+(]?[$€£¥]?\s*\d[\d,.\s]*%?\)?$/.test(s.trim());

function groupLines(items: Item[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const tol = Math.max(2, it.h * 0.4);
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    const its = l.items.sort((a, b) => a.x - b.x);
    const cells: Line["cells"] = [];
    for (const it of its) {
      const prev = cells[cells.length - 1];
      const gap = prev ? it.x - prev.x1 : 0;
      const spaceW = Math.max(3, it.h * 0.35);
      if (prev && gap < spaceW * 2.2) { prev.text += (gap > spaceW * 0.3 ? " " : "") + it.str; prev.x1 = it.x + it.w; }
      else cells.push({ text: it.str, x0: it.x, x1: it.x + it.w });
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, " ").trim();
    const kept = cells.filter((c) => c.text !== "");
    return { y: l.y, cells: kept, text: kept.map((c) => c.text).join(" ") };
  }).filter((l) => l.cells.length > 0);
}

/** Runs of ≥3 consecutive lines with ≥2 cells whose column starts line up form a table. */
function findTables(lines: Line[]): { start: number; end: number; grid: RawCell[][] }[] {
  const out: { start: number; end: number; grid: RawCell[][] }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.cells.length < 2) { i++; continue; }
    let j = i;
    const anchors: number[] = lines[i]!.cells.map((c) => c.x0);
    const aligned = (l: Line) => l.cells.length >= 2 && l.cells.every((c) => anchors.some((a) => Math.abs(a - c.x0) <= 8 || (isNum(c.text) && anchors.some((b) => Math.abs(b - c.x1) <= 60))));
    while (j < lines.length && aligned(lines[j]!)) {
      for (const c of lines[j]!.cells) if (!anchors.some((a) => Math.abs(a - c.x0) <= 8)) anchors.push(c.x0);
      j++;
    }
    if (j - i >= 3) {
      const cols = [...anchors].sort((a, b) => a - b).reduce<number[]>((acc, a) => (acc.length && a - acc[acc.length - 1]! < 8 ? acc : [...acc, a]), []);
      const grid = lines.slice(i, j).map((l) => {
        const row: RawCell[] = cols.map(() => "");
        for (const c of l.cells) {
          let k = 0;
          for (let q = 0; q < cols.length; q++) if (cols[q]! <= c.x0 + 8) k = q;
          row[k] = row[k] ? `${row[k]} ${c.text}` : c.text;
        }
        return row;
      });
      out.push({ start: i, end: j, grid });
      i = j;
    } else i++;
  }
  return out;
}

export async function extractPdf(bytes: Uint8Array, limits: IngestLimits, deadline: number): Promise<PdfResult> {
  // pdf.js's legacy build runs on Node without a canvas or DOM
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const warnings: string[] = [];
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0,
      useWorkerFetch: false, enableXfa: false, stopAtErrors: false,
    }).promise;
  } catch (e) {
    const name = (e as { name?: string }).name ?? "";
    if (name === "PasswordException") throw new IngestError("encrypted", "This PDF is password-protected.", "Remove the password and upload it again.");
    throw new IngestError("corrupt", "This PDF is damaged or couldn't be read.");
  }
  const total = doc.numPages as number;
  const pageCount = Math.min(total, limits.maxPdfPages);
  if (total > pageCount) warnings.push(`Only the first ${pageCount} of ${total} pages were read.`);
  const blocks: DocBlock[] = [];
  const tables: { page: number; grid: RawCell[][] }[] = [];
  let textChars = 0;
  try {
    for (let p = 1; p <= pageCount; p++) {
      if (Date.now() > deadline) throw new IngestError("timeout", "Reading the PDF took too long.");
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items: Item[] = [];
      for (const it of tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
        if (!it.str || !it.str.trim() || !it.transform) continue;
        items.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, w: it.width ?? 0, h: it.height || Math.abs(it.transform[3]!) || 10 });
        textChars += it.str.length;
      }
      const lines = groupLines(items);
      const found = findTables(lines);
      let cursor = 0;
      const flushText = (upTo: number) => {
        const chunk = lines.slice(cursor, upTo).map((l) => l.text);
        if (!chunk.length) return;
        // paragraphs: a larger vertical gap starts a new paragraph
        let cur: string[] = [];
        let prevY: number | null = null;
        const emit = () => { if (cur.length) { blocks.push({ type: "paragraph", text: cur.join(" "), page: p }); cur = []; } };
        for (let k = cursor; k < upTo; k++) {
          const l = lines[k]!;
          if (prevY !== null && prevY - l.y > 20) emit();
          cur.push(l.text);
          prevY = l.y;
        }
        emit();
      };
      for (const t of found) {
        flushText(t.start);
        tables.push({ page: p, grid: t.grid });
        blocks.push({ type: "table", tableIndex: tables.length - 1, page: p });
        cursor = t.end;
      }
      flushText(lines.length);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  if (textChars === 0) throw new IngestError("no_tables", "This PDF has no selectable text — it looks like a scan or image.", "Run OCR on it first, or upload the source spreadsheet or CSV.");
  return { blocks, tables, pages: total, warnings };
}
