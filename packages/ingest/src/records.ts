/** Flattening of nested records (JSON / XML) into a rectangular grid. */
import type { RawCell } from "@verinum/core";
import type { IngestLimits } from "./types";

const MAX_DEPTH = 5;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export type Rec = Map<string, RawCell>;

export function flattenRecord(v: unknown, out: Rec = new Map(), prefix = "", depth = 0, notes?: Set<string>): Rec {
  if (v === null || v === undefined) { if (prefix) out.set(prefix, null); return out; }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") { out.set(prefix || "value", v); return out; }
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) { out.set(prefix || "value", v.map((x) => (x === null ? "" : String(x))).join("; ")); return out; }
    out.set(prefix || "value", JSON.stringify(v).slice(0, 2000));
    notes?.add(`Nested lists${prefix ? ` in "${prefix}"` : ""} were kept as JSON text.`);
    return out;
  }
  if (typeof v === "object") {
    if (depth >= MAX_DEPTH) { out.set(prefix || "value", JSON.stringify(v).slice(0, 2000)); notes?.add("Deeply nested objects were kept as JSON text."); return out; }
    // XML attributes (@name) first, then child elements, so columns read id, name, … in natural order
    const entries = Object.entries(v as Record<string, unknown>);
    entries.sort((a, b) => Number(b[0].startsWith("@")) - Number(a[0].startsWith("@")));
    for (const [k, x] of entries) {
      if (FORBIDDEN.has(k)) continue;
      if (k === "#text") { flattenRecord(x, out, prefix || "value", depth + 1, notes); continue; }
      const key = k.startsWith("@") ? k.slice(1) : k;
      flattenRecord(x, out, prefix ? `${prefix}.${key}` : key, depth + 1, notes);
    }
  }
  return out;
}

export function recordsToGrid(records: unknown[], limits: IngestLimits): { columns: string[]; grid: RawCell[][]; notes: string[] } {
  const notes = new Set<string>();
  const order: string[] = [];
  const seen = new Set<string>();
  const flat: Rec[] = [];
  const cap = limits.maxRows + 1;
  for (let i = 0; i < Math.min(records.length, cap); i++) {
    const r = flattenRecord(records[i], new Map(), "", 0, notes);
    for (const k of r.keys()) if (!seen.has(k)) { seen.add(k); order.push(k); }
    flat.push(r);
  }
  let columns = order;
  if (columns.length > limits.maxColumns) { notes.add(`Only the first ${limits.maxColumns} of ${columns.length} fields were read.`); columns = columns.slice(0, limits.maxColumns); }
  const grid: RawCell[][] = [columns, ...flat.map((r) => columns.map((c) => (r.has(c) ? r.get(c)! : null)))];
  return { columns, grid, notes: [...notes] };
}

/** Finds the array of records a document is "about": the root array, or the largest array of objects in the tree. */
export function findRecordArray(root: unknown): { path: string; items: unknown[] } | null {
  if (Array.isArray(root)) return { path: "$", items: root };
  let best: { path: string; items: unknown[]; score: number } | null = null;
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const objs = v.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x)).length;
      if (v.length >= 1 && objs / v.length > 0.8) {
        const score = v.length * (1 + Math.min(10, Object.keys(v[0] as object).length) / 10);
        if (!best || score > best.score) best = { path, items: v, score };
      }
      for (const x of v.slice(0, 3)) walk(x, `${path}[]`, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`, depth + 1);
  };
  walk(root, "$", 0);
  if (best) { const b = best as { path: string; items: unknown[] }; return { path: b.path, items: b.items }; }
  return null;
}
