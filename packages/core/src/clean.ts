/**
 * Raw table → analysis-ready typed Frame, with a user-visible log of every change.
 *
 * Principles (spec §11):
 *  - the original file is never modified; this produces a *separate* analysis representation
 *  - only lossless-safe normalisations are applied automatically (trim, null tokens, numeric /
 *    date parsing); each is logged with counts and examples
 *  - risky changes (dropping duplicates, merging label variants, removing outliers) are
 *    *suggestions* and are never applied silently
 */
import {
  DictBuilder, Frame, NULL_BOOL, NULL_CODE, NULL_DATE,
  type Column, type DateMeta, type NumberMeta,
} from "./frame";
import {
  detectDateOrder, detectDecimalLocale, isNullToken, parseBoolToken, parseDateCell, parseNumberCell,
  type DateOrder,
} from "./values";

export type RawCell = string | number | boolean | null | undefined;

export interface RawTable {
  name?: string;
  columns: string[];
  rows: RawCell[][];
}

export type TransformKind =
  | "rename_column" | "trim_whitespace" | "null_tokens" | "drop_empty_rows" | "parse_numbers"
  | "parse_dates" | "parse_booleans" | "coerce_invalid" | "detect_locale" | "date_order"
  | "remove_duplicates" | "normalize_labels" | "drop_columns";

export interface Transformation {
  id: string;
  kind: TransformKind;
  column?: string;
  /** number of cells/rows/columns touched */
  affected: number;
  severity: "info" | "notice" | "warning";
  /** plain-language explanation shown to the user */
  detail: string;
  examples?: string[];
}

export type SuggestionKind =
  | "remove_duplicates" | "normalize_labels" | "review_outliers" | "drop_empty_column"
  | "confirm_date_order" | "review_mixed_type" | "review_negative_values";

export interface CleanSuggestion {
  id: string;
  kind: SuggestionKind;
  column?: string;
  detail: string;
  /** what would change if the user accepts it */
  proposedAction: string;
  affected: number;
}

export interface ColumnCleanInfo {
  name: string;
  originalName: string;
  present: number;
  nullCount: number;
  nullTokenCells: number;
  trimmedCells: number;
  coercedCells: number;
  coercedExamples: string[];
  numericStringsParsed: number;
  currency?: string;
  percentStrings: number;
  decimalLocale?: "us" | "eu";
  dateOrder?: DateOrder;
  dateOrderAmbiguous?: boolean;
  /** share of non-null cells that parsed under the chosen type (1 for strings) */
  parseRate: number;
  /** ratio of candidate-type parse success when the column was rejected as mixed */
  mixedCandidate?: { kind: "number" | "date"; rate: number };
}

export interface CleanResult {
  frame: Frame;
  log: Transformation[];
  suggestions: CleanSuggestion[];
  columns: ColumnCleanInfo[];
  droppedEmptyRows: number;
  duplicateRows: number;
  /** 1 for every row that exactly repeats an earlier row (all columns compared) */
  duplicateMask: Uint8Array;
}

export interface CleanOptions {
  /** Minimum share of non-null cells that must parse for a column to become numeric/date. */
  typeThreshold?: number;
  /** User-confirmed day/month order per column. Overrides detection and clears the "ambiguous" flag. */
  dateOrders?: Record<string, DateOrder>;
}

const MAX_HEADER_LEN = 200;

function normalizeHeaders(columns: string[], log: Transformation[]): { names: string[]; originals: string[] } {
  const seen = new Map<string, number>();
  const names: string[] = [];
  columns.forEach((h, i) => {
    let base = String(h ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_HEADER_LEN);
    if (!base) base = `column_${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const name = count > 1 ? `${base}_${count}` : base;
    if (name !== String(h ?? "")) {
      log.push({
        id: `rename-${i}`, kind: "rename_column", column: name, affected: 1, severity: "info",
        detail: !String(h ?? "").trim()
          ? `Column ${i + 1} had no header and was named "${name}".`
          : count > 1 ? `Duplicate header "${base}" was renamed to "${name}".` : `Header "${h}" was tidied to "${name}".`,
      });
    }
    names.push(name);
  });
  return { names, originals: columns.map((c) => String(c ?? "")) };
}

const asText = (v: RawCell): string => (typeof v === "string" ? v : String(v));

function sampleStrings(rows: RawCell[][], col: number, keep: number[] | null, max: number): string[] {
  const n = keep ? keep.length : rows.length;
  const out: string[] = [];
  const stride = Math.max(1, Math.floor(n / max));
  for (let k = 0; k < n; k += stride) {
    const v = rows[keep ? keep[k]! : k]![col];
    if (typeof v === "string") { const t = v.trim(); if (t && !isNullToken(t)) out.push(t); }
    if (out.length >= max) break;
  }
  return out;
}

export function buildFrame(raw: RawTable, opts: CleanOptions = {}): CleanResult {
  const threshold = opts.typeThreshold ?? 0.9;
  const log: Transformation[] = [];
  const suggestions: CleanSuggestion[] = [];
  const { names, originals } = normalizeHeaders(raw.columns, log);
  const width = names.length;

  // 1. drop fully-empty rows (recorded, never silent)
  let keep: number[] | null = null;
  {
    const kept: number[] = [];
    for (let i = 0; i < raw.rows.length; i++) {
      const r = raw.rows[i]!;
      let any = false;
      for (let j = 0; j < width; j++) { if (!isNullToken(r[j])) { any = true; break; } }
      if (any) kept.push(i);
    }
    if (kept.length !== raw.rows.length) {
      log.push({
        id: "drop-empty-rows", kind: "drop_empty_rows", affected: raw.rows.length - kept.length, severity: "info",
        detail: `${raw.rows.length - kept.length} completely empty row(s) were ignored.`,
      });
      keep = kept;
    }
  }
  const n = keep ? keep.length : raw.rows.length;
  const rowAt = (k: number): RawCell[] => raw.rows[keep ? keep[k]! : k]!;

  const columns: Column[] = [];
  const infos: ColumnCleanInfo[] = [];

  for (let j = 0; j < width; j++) {
    const name = names[j]!;
    const info: ColumnCleanInfo = {
      name, originalName: originals[j]!, present: 0, nullCount: 0, nullTokenCells: 0, trimmedCells: 0,
      coercedCells: 0, coercedExamples: [], numericStringsParsed: 0, percentStrings: 0, parseRate: 1,
    };

    // ---- pass 1: counts + sample to choose a candidate type ----
    let allNumberTyped = true;
    let anyNonNull = false;
    for (let k = 0; k < n; k++) {
      const v = rowAt(k)[j];
      if (v === null || v === undefined) { info.nullCount++; continue; }
      if (typeof v === "string") {
        const t = v.trim();
        if (t.length !== v.length) info.trimmedCells++;
        if (isNullToken(t)) { info.nullCount++; if (t !== "") info.nullTokenCells++; continue; }
        allNumberTyped = false;
      } else if (typeof v === "number") {
        if (Number.isNaN(v)) { info.nullCount++; continue; }
      } else allNumberTyped = false;
      anyNonNull = true;
      info.present++;
    }

    const probe = sampleStrings(raw.rows, j, keep, 1500);
    let kind: "number" | "date" | "boolean" | "string" = "string";
    let locale: "us" | "eu" = "us";
    let order: DateOrder = "mdy";
    let ambiguous = false;

    if (!anyNonNull) {
      kind = "string";
    } else if (allNumberTyped) {
      kind = "number";
    } else if (probe.length) {
      locale = detectDecimalLocale(probe);
      const detected = detectDateOrder(probe);
      const forced = opts.dateOrders?.[name];
      const dOrder = forced ? { ...detected, order: forced, ambiguous: false } : detected;
      let nHit = 0, dHit = 0, bHit = 0;
      const boolTokens = new Set<number>();
      for (const s of probe) {
        if (parseNumberCell(s, locale)) nHit++;
        else if (parseDateCell(s, dOrder.order)) dHit++;
        const b = parseBoolToken(s);
        if (b !== null) { bHit++; boolTokens.add(b); }
      }
      const nr = nHit / probe.length, dr = dHit / probe.length, br = bHit / probe.length;
      // A column of only yes/no/true/false tokens. (Bare 0/1 columns stay numeric; the profiler labels them boolean.)
      const distinctBoolTexts = new Set(probe.map((s) => s.toLowerCase()));
      if (br >= threshold && distinctBoolTexts.size <= 4 && !probe.every((s) => parseNumberCell(s))) kind = "boolean";
      else if (nr >= 0.6 && nr >= dr) kind = "number";
      else if (dr >= 0.6) kind = "date";
      order = dOrder.order;
      ambiguous = dOrder.ambiguous;
      if (kind === "string") {
        // Not confident enough to type the column, but worth telling the user about.
        if (nr >= 0.3 && nr >= dr) info.mixedCandidate = { kind: "number", rate: nr };
        else if (dr >= 0.3) info.mixedCandidate = { kind: "date", rate: dr };
      }
    }

    // ---- pass 2: build typed storage ----
    let col: Column | null = null;

    if (kind === "number") {
      const values = new Float64Array(n).fill(NaN);
      let ok = 0, fail = 0;
      const curCount = new Map<string, number>();
      for (let k = 0; k < n; k++) {
        const v = rowAt(k)[j];
        if (v === null || v === undefined) continue;
        if (typeof v === "number") { if (!Number.isNaN(v)) { values[k] = v; ok++; } continue; }
        const t = asText(v).trim();
        if (isNullToken(t)) continue;
        const p = parseNumberCell(t, locale);
        if (p) {
          values[k] = p.value; ok++;
          if (typeof v === "string") info.numericStringsParsed++;
          if (p.currency) curCount.set(p.currency, (curCount.get(p.currency) ?? 0) + 1);
          if (p.percent) info.percentStrings++;
        } else {
          fail++;
          if (info.coercedExamples.length < 5) info.coercedExamples.push(t.slice(0, 40));
        }
      }
      const rate = info.present ? ok / info.present : 0;
      if (rate >= threshold) {
        info.parseRate = rate;
        info.coercedCells = fail;
        info.decimalLocale = locale;
        const meta: NumberMeta = { decimalLocale: locale };
        let best: [string, number] | null = null;
        for (const e of curCount) if (!best || e[1] > best[1]) best = e;
        if (best && best[1] >= ok * 0.3) { meta.currency = best[0]; info.currency = best[0]; }
        if (info.percentStrings >= ok * 0.5) meta.percent = true;
        col = { kind: "number", name, values, meta };
      } else {
        info.mixedCandidate = { kind: "number", rate };
        info.coercedCells = 0; info.coercedExamples = [];
        kind = "string";
      }
    } else if (kind === "date") {
      const values = new Int32Array(n).fill(NULL_DATE);
      let ok = 0, fail = 0, hasTime = false;
      for (let k = 0; k < n; k++) {
        const v = rowAt(k)[j];
        if (v === null || v === undefined) continue;
        const t = asText(v).trim();
        if (isNullToken(t)) continue;
        const p = parseDateCell(t, order);
        if (p) { values[k] = p.days; ok++; if (p.hasTime) hasTime = true; }
        else { fail++; if (info.coercedExamples.length < 5) info.coercedExamples.push(t.slice(0, 40)); }
      }
      const rate = info.present ? ok / info.present : 0;
      if (rate >= threshold) {
        info.parseRate = rate;
        info.coercedCells = fail;
        info.dateOrder = order;
        info.dateOrderAmbiguous = ambiguous;
        const meta: DateMeta = { order, orderAmbiguous: ambiguous, hasTime };
        col = { kind: "date", name, values, meta };
      } else {
        info.mixedCandidate = { kind: "date", rate };
        info.coercedCells = 0; info.coercedExamples = [];
        kind = "string";
      }
    } else if (kind === "boolean") {
      const values = new Uint8Array(n).fill(NULL_BOOL);
      let ok = 0;
      for (let k = 0; k < n; k++) {
        const v = rowAt(k)[j];
        if (v === null || v === undefined) continue;
        const t = asText(v).trim();
        if (isNullToken(t)) continue;
        const b = parseBoolToken(v);
        if (b !== null) { values[k] = b; ok++; }
      }
      info.parseRate = info.present ? ok / info.present : 1;
      col = { kind: "boolean", name, values };
    }

    if (!col) {
      const dict = new DictBuilder();
      const codes = new Uint32Array(n).fill(NULL_CODE);
      for (let k = 0; k < n; k++) {
        const v = rowAt(k)[j];
        if (v === null || v === undefined) continue;
        const t = asText(v).trim();
        if (isNullToken(t)) continue;
        codes[k] = dict.code(t);
      }
      col = { kind: "string", name, codes, dict: dict.dict };
    }
    columns.push(col);
    infos.push(info);
  }

  const frame = new Frame(n, columns);

  // ---- transformation log (only what was actually applied) ----
  for (const info of infos) {
    const c = frame.get(info.name)!;
    if (info.trimmedCells > 0) {
      log.push({ id: `trim-${info.name}`, kind: "trim_whitespace", column: info.name, affected: info.trimmedCells, severity: "info",
        detail: `Leading/trailing spaces were removed from ${info.trimmedCells.toLocaleString("en-US")} value(s) in "${info.name}".` });
    }
    if (info.nullTokenCells > 0) {
      log.push({ id: `nulltok-${info.name}`, kind: "null_tokens", column: info.name, affected: info.nullTokenCells, severity: "notice",
        detail: `${info.nullTokenCells.toLocaleString("en-US")} placeholder value(s) such as "N/A", "null" or "-" in "${info.name}" were treated as blank.` });
    }
    if (c.kind === "number" && info.numericStringsParsed > 0) {
      const bits = [
        info.currency ? `currency symbols (${info.currency})` : null,
        info.percentStrings ? "percent signs (stored as fractions, so 12% = 0.12)" : null,
        info.decimalLocale === "eu" ? "European number format (1.234,56)" : null,
      ].filter(Boolean);
      log.push({ id: `num-${info.name}`, kind: "parse_numbers", column: info.name, affected: info.numericStringsParsed, severity: "info",
        detail: `${info.numericStringsParsed.toLocaleString("en-US")} text value(s) in "${info.name}" were read as numbers${bits.length ? `, handling ${bits.join(", ")}` : ""}.` });
    }
    if (c.kind === "date") {
      log.push({ id: `date-${info.name}`, kind: "parse_dates", column: info.name, affected: info.present, severity: info.dateOrderAmbiguous ? "warning" : "info",
        detail: info.dateOrderAmbiguous
          ? `"${info.name}" was read as dates. Day/month order could not be proven from the data, so month-first (MM/DD) was assumed. Confirm this if your dates are day-first.`
          : `"${info.name}" was read as dates${info.dateOrder === "dmy" ? " (day-first order detected from values such as 13/01/2025)" : ""}. Time-of-day, if present, is ignored.` });
      if (info.dateOrderAmbiguous) {
        suggestions.push({ id: `dateorder-${info.name}`, kind: "confirm_date_order", column: info.name, affected: info.present,
          detail: `Every date in "${info.name}" is valid in both day-first and month-first order.`,
          proposedAction: "Confirm whether dates are DD/MM or MM/DD." });
      }
    }
    if (c.kind === "boolean") {
      log.push({ id: `bool-${info.name}`, kind: "parse_booleans", column: info.name, affected: info.present, severity: "info",
        detail: `"${info.name}" holds yes/no or true/false values and was stored as a boolean.` });
    }
    if (info.coercedCells > 0) {
      log.push({ id: `coerce-${info.name}`, kind: "coerce_invalid", column: info.name, affected: info.coercedCells, severity: "warning",
        detail: `${info.coercedCells.toLocaleString("en-US")} value(s) in "${info.name}" could not be read as ${c.kind === "number" ? "numbers" : "dates"} and were left blank (e.g. ${info.coercedExamples.slice(0, 3).map((e) => `"${e}"`).join(", ")}).`,
        examples: info.coercedExamples });
    }
    if (info.mixedCandidate && info.mixedCandidate.rate >= 0.3) {
      suggestions.push({ id: `mixed-${info.name}`, kind: "review_mixed_type", column: info.name, affected: info.present,
        detail: `"${info.name}" mixes ${info.mixedCandidate.kind === "number" ? "numbers" : "dates"} and text (${Math.round(info.mixedCandidate.rate * 100)}% parse as ${info.mixedCandidate.kind === "number" ? "numbers" : "dates"}), so it was kept as text.`,
        proposedAction: `Clean the non-${info.mixedCandidate.kind} entries upstream, or exclude the column.` });
    }
  }

  // ---- duplicates: every column compared (the prototype compared only the first 24) ----
  const { mask, count: duplicateRows } = duplicateMaskOf(frame);
  if (duplicateRows > 0) {
    suggestions.push({
      id: "dupes", kind: "remove_duplicates", affected: duplicateRows,
      detail: `${duplicateRows.toLocaleString("en-US")} row(s) (${((duplicateRows / Math.max(1, n)) * 100).toFixed(2)}%) exactly repeat an earlier row across all ${width} columns. They were kept in the analysis.`,
      proposedAction: "Exclude exact duplicate rows from the analysis (the original file is never changed).",
    });
  }
  // ---- label variants (case / whitespace only) ----
  for (const c of frame.columns) {
    if (c.kind !== "string" || c.dict.length < 2 || c.dict.length > 5000) continue;
    const groups = new Map<string, string[]>();
    for (const v of c.dict) {
      const key = v.toLowerCase().replace(/\s+/g, " ");
      const arr = groups.get(key);
      if (arr) arr.push(v); else groups.set(key, [v]);
    }
    const clashes = [...groups.values()].filter((g) => g.length > 1);
    if (clashes.length) {
      suggestions.push({
        id: `labels-${c.name}`, kind: "normalize_labels", column: c.name, affected: clashes.length,
        detail: `"${c.name}" has ${clashes.length} label(s) that differ only by letter case or spacing (e.g. ${clashes[0]!.slice(0, 3).map((x) => `"${x}"`).join(" / ")}). They are counted as separate categories.`,
        proposedAction: "Merge label variants into one canonical spelling.",
      });
    }
  }
  for (const info of infos) {
    if (info.present === 0) {
      suggestions.push({ id: `empty-${info.name}`, kind: "drop_empty_column", column: info.name, affected: 0,
        detail: `"${info.name}" has no values at all.`, proposedAction: "Exclude this column from the analysis." });
    }
  }

  return { frame, log, suggestions, columns: infos, droppedEmptyRows: raw.rows.length - n, duplicateRows, duplicateMask: mask };
}

/** Marks rows that exactly repeat an earlier row, hashing every column's cell value. */
export function duplicateMaskOf(frame: Frame): { mask: Uint8Array; count: number } {
  const n = frame.rowCount;
  const mask = new Uint8Array(n);
  if (n < 2 || frame.columns.length === 0) return { mask, count: 0 };
  const seen = new Set<number>();
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  let count = 0;
  for (let i = 0; i < n; i++) {
    let h1 = 0x811c9dc5 | 0, h2 = 0x9747b28c | 0;
    for (const c of frame.columns) {
      let a: number, b: number;
      switch (c.kind) {
        case "number": f64[0] = c.values[i]!; a = u32[0]!; b = u32[1]!; break;
        case "date": a = c.values[i]!; b = 7; break;
        case "string": a = c.codes[i]!; b = 13; break;
        default: a = c.values[i]!; b = 3; break;
      }
      h1 = Math.imul(h1 ^ a, 0x01000193); h1 ^= h1 >>> 15;
      h2 = Math.imul(h2 ^ b ^ (a >>> 7), 0x85ebca6b); h2 ^= h2 >>> 13;
    }
    const key = (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
    if (seen.has(key)) { mask[i] = 1; count++; } else seen.add(key);
  }
  return { mask, count };
}
