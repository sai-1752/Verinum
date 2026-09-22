import type { RawCell } from "@verinum/core";
import { findRecordArray, recordsToGrid } from "./records";
import { IngestError, type IngestLimits } from "./types";

export interface JsonResult { grid: RawCell[][]; notes: string[]; recordPath: string }

export function parseJsonText(text: string, limits: IngestLimits, ndjson: boolean): JsonResult {
  let root: unknown;
  try {
    if (ndjson) {
      const items: unknown[] = [];
      const lines = text.split(/\r?\n/);
      let bad = 0;
      for (const l of lines) {
        if (!l.trim()) continue;
        if (items.length >= limits.maxRows + 1) break;
        try { items.push(JSON.parse(l)); } catch { bad++; }
      }
      if (!items.length) throw new Error("no valid lines");
      root = items;
      if (bad) return withNotes(root, limits, [`${bad} line${bad === 1 ? "" : "s"} were not valid JSON and were skipped.`]);
    } else {
      root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    }
  } catch {
    throw new IngestError("corrupt", "This file isn't valid JSON.", "Check for a missing bracket, comma or quote.");
  }
  return withNotes(root, limits, []);
}

function withNotes(root: unknown, limits: IngestLimits, extra: string[]): JsonResult {
  // array of arrays: first row is the header
  if (Array.isArray(root) && root.length > 0 && root.every((r) => Array.isArray(r))) {
    return { grid: (root as unknown[][]).map((r) => r.map((c) => (c === null || typeof c === "object" ? (c === null ? null : JSON.stringify(c)) : (c as RawCell)))), notes: extra, recordPath: "$" };
  }
  let found = findRecordArray(root);
  const notes = [...extra];
  if (!found) {
    // an object keyed by id → one row per key; a lone object → one row
    if (root && typeof root === "object" && !Array.isArray(root)) {
      const entries = Object.entries(root as Record<string, unknown>);
      const objectValues = entries.filter(([, v]) => v && typeof v === "object" && !Array.isArray(v));
      if (entries.length >= 2 && objectValues.length / entries.length > 0.8) {
        found = { path: "$", items: objectValues.map(([k, v]) => ({ key: k, ...(v as object) })) };
        notes.push("The object's keys became a “key” column.");
      } else found = { path: "$", items: [root] };
    } else throw new IngestError("no_tables", "The JSON doesn't contain rows of data.", "Expected an array of objects, or an object holding one.");
  } else if (found.path !== "$") notes.push(`Rows were read from ${found.path}.`);
  if (!found.items.length) throw new IngestError("empty", "The JSON contains an empty list.");
  const { grid, notes: n2 } = recordsToGrid(found.items, limits);
  return { grid, notes: [...notes, ...n2], recordPath: found.path };
}
