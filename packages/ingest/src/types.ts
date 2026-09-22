import type { RawCell } from "@verinum/core";

export type DetectedFormat =
  | "csv" | "tsv" | "delimited" | "fixed_width" | "xlsx" | "xls" | "json" | "ndjson" | "xml" | "html" | "pdf" | "docx" | "txt";

export interface IngestLimits {
  /** raw upload size */
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  /** characters kept per cell (longer cells are truncated and reported) */
  maxCellChars: number;
  /** total uncompressed bytes allowed inside a container (xlsx/docx) — zip-bomb guard */
  maxUncompressedBytes: number;
  maxZipEntries: number;
  /** per-entry expansion ratio guard (uncompressed ÷ compressed) once an entry exceeds 1 MB */
  maxCompressionRatio: number;
  maxPdfPages: number;
  maxSheets: number;
  /** wall-clock budget for the whole extraction */
  timeoutMs: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxRows: 1_000_000,
  maxColumns: 500,
  maxCellChars: 32_768,
  maxUncompressedBytes: 400 * 1024 * 1024,
  maxZipEntries: 5_000,
  maxCompressionRatio: 200,
  maxPdfPages: 300,
  maxSheets: 50,
  timeoutMs: 120_000,
};

export interface TableSource { sheet?: string; page?: number; index: number; kind: "sheet" | "table" | "records" | "text" | "file" }

export interface ExtractedTable {
  name: string;
  columns: string[];
  rows: RawCell[][];
  source: TableSource;
  /** plain-language notes about how this table was found or trimmed */
  notes: string[];
  truncated: boolean;
}

export type DocBlock =
  | { type: "heading"; level: number; text: string; page?: number }
  | { type: "paragraph"; text: string; page?: number }
  | { type: "table"; tableIndex: number; page?: number };

export interface StructuredDocument {
  title: string | null;
  blocks: DocBlock[];
  keyValues: { key: string; value: string; page?: number }[];
  pages?: number;
  wordCount: number;
}

export interface IngestResult {
  format: DetectedFormat;
  /** how the format was decided (shown to the user: "detected from file contents, not the extension") */
  formatReason: string;
  encoding?: string;
  delimiter?: string;
  tables: ExtractedTable[];
  document?: StructuredDocument;
  warnings: string[];
  stats: { bytes: number; ms: number };
}

export type IngestErrorCode =
  | "unsupported_format" | "too_large" | "encrypted" | "corrupt" | "empty" | "limit_exceeded" | "timeout" | "no_tables";

export class IngestError extends Error {
  constructor(readonly code: IngestErrorCode, message: string, readonly hint?: string) {
    super(message);
    this.name = "IngestError";
  }
}
