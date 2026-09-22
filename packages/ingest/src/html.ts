import { parse, type HTMLElement } from "node-html-parser";
import type { RawCell } from "@verinum/core";
import type { DocBlock, IngestLimits } from "./types";
import { tidyName } from "./tableutil";

export interface HtmlTable { name: string; grid: RawCell[][]; hasHeaderRow: boolean }

const text = (el: HTMLElement) => el.text.replace(/\s+/g, " ").trim();

export function parseHtml(source: string, limits: IngestLimits): { tables: HtmlTable[]; blocks: DocBlock[]; warnings: string[] } {
  const warnings: string[] = [];
  const root = parse(source.length > 20_000_000 ? source.slice(0, 20_000_000) : source, { comment: false, blockTextElements: { script: false, noscript: false, style: false, pre: true } });
  for (const el of root.querySelectorAll("script, style, noscript, iframe, object, embed, template")) el.remove();
  const tables: HtmlTable[] = [];
  const blocks: DocBlock[] = [];
  let lastHeading = "";
  const visit = (el: HTMLElement) => {
    for (const child of el.childNodes) {
      const c = child as HTMLElement;
      const tag = c.tagName?.toLowerCase();
      if (!tag) continue;
      if (/^h[1-6]$/.test(tag)) { const t = text(c); if (t) { blocks.push({ type: "heading", level: Number(tag[1]), text: t }); lastHeading = t; } continue; }
      if (tag === "p" || tag === "li" || tag === "pre" || tag === "blockquote") { const t = text(c); if (t) blocks.push({ type: "paragraph", text: t }); continue; }
      if (tag === "table") {
        if (tables.length >= limits.maxSheets) { continue; }
        const t = readTable(c, tables.length, lastHeading, limits);
        if (t) { tables.push(t); blocks.push({ type: "table", tableIndex: tables.length - 1 }); }
        continue;
      }
      visit(c);
    }
  };
  visit(root);
  if (tables.length >= limits.maxSheets) warnings.push(`Only the first ${limits.maxSheets} tables were read.`);
  return { tables, blocks, warnings };
}

function readTable(t: HTMLElement, idx: number, heading: string, limits: IngestLimits): HtmlTable | null {
  if (t.querySelector("table table")) {
    // layout table wrapping other tables: the inner ones are handled when visited
    return null;
  }
  const trs = t.querySelectorAll("tr");
  if (trs.length < 2) return null;
  const grid: RawCell[][] = [];
  const carry: { text: string; left: number }[] = []; // rowspan carry-over per column
  let hasTh = false;
  for (const tr of trs.slice(0, limits.maxRows + 2)) {
    const row: RawCell[] = [];
    let col = 0;
    const cells = tr.childNodes.filter((n) => ["td", "th"].includes((n as HTMLElement).tagName?.toLowerCase() ?? "")) as HTMLElement[];
    if (cells.some((c) => c.tagName.toLowerCase() === "th")) hasTh = hasTh || grid.length === 0;
    for (const cell of cells) {
      while (carry[col] && carry[col]!.left > 0) { row[col] = carry[col]!.text; carry[col]!.left--; col++; }
      const v = text(cell);
      const cs = Math.min(50, Math.max(1, Number(cell.getAttribute("colspan") ?? 1) || 1));
      const rs = Math.min(200, Math.max(1, Number(cell.getAttribute("rowspan") ?? 1) || 1));
      for (let k = 0; k < cs; k++) {
        row[col] = k === 0 ? v : "";
        if (rs > 1) carry[col] = { text: k === 0 ? v : "", left: rs - 1 };
        col++;
      }
    }
    while (carry[col] && carry[col]!.left > 0) { row[col] = carry[col]!.text; carry[col]!.left--; col++; }
    if (row.some((c) => c !== undefined && c !== "")) grid.push(Array.from(row, (c) => c ?? ""));
  }
  if (grid.length < 2 || Math.max(...grid.map((r) => r.length)) < 2) return null;
  const caption = t.querySelector("caption");
  return { name: tidyName(caption ? text(caption) : heading, `Table ${idx + 1}`), grid, hasHeaderRow: hasTh };
}
