/**
 * Format detection from file CONTENTS. The extension is only a tie-breaker between text formats
 * (a ".csv" that starts with %PDF is a PDF; a ".xlsx" that is plain text is text).
 */
import { decodeText, looksLikeText } from "./encoding";
import { readZip } from "./safe-zip";
import { DEFAULT_LIMITS, IngestError, type DetectedFormat, type IngestLimits } from "./types";

export interface Sniffed { format: DetectedFormat | "zip_other"; reason: string; macros?: boolean }

const ascii = (b: Uint8Array, from: number, s: string) => s.split("").every((ch, i) => b[from + i] === ch.charCodeAt(0));

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : "";
}

export function sniffFormat(bytes: Uint8Array, filename: string, limits: IngestLimits = DEFAULT_LIMITS): Sniffed {
  if (bytes.length === 0) throw new IngestError("empty", "The file is empty.");
  const ext = extensionOf(filename);

  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    // A ZIP container. Peek at the entry names only (bounded by the same limits).
    const { scan } = readZip(bytes, limits, () => false);
    const names = new Set(scan.names);
    if (names.has("xl/workbook.xml") || names.has("xl/workbook.bin")) {
      if (names.has("xl/workbook.bin")) throw new IngestError("unsupported_format", "Binary Excel workbooks (.xlsb) are not supported.", "Save the workbook as .xlsx or CSV and upload that.");
      return { format: "xlsx", reason: "ZIP container with an Excel workbook (xl/workbook.xml)", macros: names.has("xl/vbaProject.bin") };
    }
    if (names.has("word/document.xml")) return { format: "docx", reason: "ZIP container with a Word document (word/document.xml)" };
    if (names.has("EncryptedPackage")) throw new IngestError("encrypted", "This file is password-protected.", "Remove the password and upload it again.");
    return { format: "zip_other", reason: "ZIP archive that is not an Office document" };
  }
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) {
    return { format: "xls", reason: "OLE2 compound file (legacy Excel)" };
  }
  if (bytes.length >= 5 && ascii(bytes, 0, "%PDF-")) return { format: "pdf", reason: "PDF header (%PDF-)" };
  // %PDF- may follow a few bytes of junk in some generators
  if (bytes.length > 1024) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    if (head.includes("%PDF-")) return { format: "pdf", reason: "PDF header (%PDF-) near the start of the file" };
  }
  if (!looksLikeText(bytes)) throw new IngestError("unsupported_format", "This file type isn't supported.", "Supported: CSV, TSV, Excel (.xlsx/.xls), JSON, XML, HTML, PDF, Word (.docx), text and fixed-width files.");

  const { text } = decodeText(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  const head = text.replace(/^﻿/, "").trimStart();
  const lower = head.slice(0, 400).toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html") || /<(table|body|head)[\s>]/.test(lower)) return { format: "html", reason: "HTML markup" };
  if (lower.startsWith("<?xml") || (lower.startsWith("<") && /^<[a-z_][\w:.-]*[\s>/]/i.test(head))) return { format: "xml", reason: "XML markup" };
  if (head.startsWith("{") || head.startsWith("[")) {
    // NDJSON: several lines that each parse as JSON objects
    const lines = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
    if (lines.length >= 2 && lines.slice(0, 2).every((l) => l.trim().startsWith("{") && safeParses(l))) return { format: "ndjson", reason: "One JSON object per line" };
    // valid JSON, or clearly meant to be JSON (extension or key/value shape) — a parse error is then reported as such
    if (bytes.length > 64 * 1024 || safeParses(text) || ["json", "ndjson", "jsonl"].includes(ext) || /^\s*[\[{][\s\S]{0,200}?"\s*:/.test(head)) return { format: "json", reason: "JSON document" };
  }
  if (ext === "tsv" || ext === "tab") return { format: "tsv", reason: "Tab-separated text (by extension)" };
  if (ext === "csv") return { format: "csv", reason: "Delimited text (by extension and content)" };
  return { format: "txt", reason: "Plain text" };
}

function safeParses(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}
