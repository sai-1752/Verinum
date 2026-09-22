import { parse } from "csv-parse/sync";
import type { RawCell } from "@verinum/core";
import { IngestError, type IngestLimits } from "./types";

const CANDIDATES = [",", ";", "\t", "|"] as const;

/** Quote-aware field count of one line. */
function fieldCount(line: string, d: string): number {
  let n = 1, inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') { if (inQ && line[i + 1] === '"') i++; else inQ = !inQ; }
    else if (ch === d && !inQ) n++;
  }
  return n;
}

export interface DelimiterGuess { delimiter: string; score: number; columns: number }

/** Picks the delimiter whose per-line field counts are most consistent (and > 1). Null = not delimited text. */
export function detectDelimiter(text: string, preferred?: string): DelimiterGuess | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 60);
  if (lines.length < 1) return null;
  let best: DelimiterGuess | null = null;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => fieldCount(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 1, modeN = 0;
    for (const [c, n] of freq) if (c > 1 && n > modeN) { mode = c; modeN = n; }
    if (modeN === 0) continue;
    const consistency = modeN / lines.length;
    // more columns and a preferred delimiter (from the extension) break ties
    const score = consistency * 100 + Math.min(mode, 20) * 0.1 + (d === preferred ? 1 : 0);
    if (!best || score > best.score) best = { delimiter: d, score, columns: mode };
  }
  if (!best) return null;
  // a single-line file needs ≥2 fields; multi-line files need most lines to agree
  return lines.length === 1 ? (best.columns >= 2 ? best : null) : best.score >= 60 ? best : null;
}

export function parseDelimited(text: string, delimiter: string, limits: IngestLimits): { grid: RawCell[][]; warnings: string[] } {
  const warnings: string[] = [];
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    const grid = parse(src, {
      delimiter, quote: '"', escape: '"', relax_quotes: true, relax_column_count: true,
      skip_empty_lines: true, max_record_size: Math.max(16 * 1024 * 1024, limits.maxCellChars * 4), to: limits.maxRows + 60,
      bom: true, trim: false,
    }) as string[][];
    return { grid, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/max_record_size|Max Record Size/i.test(msg)) throw new IngestError("limit_exceeded", "A single row in this file is extremely large.", "Check that the delimiter and quoting are correct.");
    // last resort: tolerant line-based split, and say so
    warnings.push("Some rows had unbalanced quotes; the file was read line by line and a few values may be split incorrectly.");
    const grid = src.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, limits.maxRows + 60).map((l) => l.split(delimiter).map((c) => c.replace(/^"|"$/g, "")));
    return { grid, warnings };
  }
}
