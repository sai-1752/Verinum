/**
 * Document structuring: turns extracted text/tables (PDF, DOCX, HTML, TXT) into headings,
 * paragraphs, key-value pairs and tables, so unstructured files still yield something analysable
 * and every extracted table remembers where it came from.
 */
import type { DocBlock, StructuredDocument } from "./types";

const KV = /^\s*([A-Za-z][A-Za-z0-9 #/&()._-]{1,40}?)\s*[:：]\s+(\S.{0,200})$/;
const KV_LEADER = /^\s*([A-Za-z][A-Za-z0-9 #/&()._-]{1,40}?)\s*(?:\.{3,}|\s{3,})\s*([$€£¥]?\s?-?\d[\d,.]*\s?%?)\s*$/;

export function extractKeyValues(lines: string[], page?: number): { key: string; value: string; page?: number }[] {
  const out: { key: string; value: string; page?: number }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length > 240) continue;
    const m = KV.exec(line) ?? KV_LEADER.exec(line);
    if (!m) continue;
    const key = m[1]!.trim().replace(/\s+/g, " ");
    // prose like "Note: ..." is fine, but skip URLs and times such as "10:30"
    if (/^(https?|ftp)$/i.test(key) || /^\d+$/.test(key)) continue;
    const id = `${key}|${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, value: m[2]!.trim(), ...(page ? { page } : {}) });
    if (out.length >= 200) break;
  }
  return out;
}

export function buildDocument(blocks: DocBlock[], pages?: number): StructuredDocument {
  const text = blocks.flatMap((b) => (b.type === "table" ? [] : [b.text]));
  const title = blocks.find((b) => b.type === "heading")?.type === "heading" ? (blocks.find((b) => b.type === "heading") as { text: string }).text : (text[0]?.slice(0, 120) ?? null);
  const keyValues = extractKeyValues(blocks.flatMap((b) => (b.type === "paragraph" ? b.text.split(/\n/) : [])));
  const wordCount = text.join(" ").split(/\s+/).filter(Boolean).length;
  return { title: title || null, blocks, keyValues, pages, wordCount };
}

/** Splits free text into paragraphs (blank-line separated) and promotes short ALL-CAPS/numbered lines to headings. */
export function blocksFromText(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const t = para.replace(/[ \t]+/g, " ").trim();
    if (!t) continue;
    if (t.length <= 80 && !t.includes("\n") && (/^[A-Z0-9][A-Z0-9 &/,.-]{3,}$/.test(t) || /^\d+(\.\d+)*\.?\s+[A-Z]/.test(t)) && !/[.!?]$/.test(t)) blocks.push({ type: "heading", level: 2, text: t });
    else blocks.push({ type: "paragraph", text: t });
  }
  return blocks;
}
