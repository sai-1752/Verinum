import { AnalyticsError } from "../analytics/errors";
import { applyFilters, closestValues, dateRangeFromKey, type Filter } from "../analytics/filter";
import { aggregate, narrow, type AnalysisContext } from "../context";
import type { ChartSpec } from "../charts";
import { FactSet, type ToolResult } from "../facts";
import type { StringColumn } from "../frame";
import { formatIsoDate } from "../time";
import type { ColumnProfile } from "../types";
import type { JsonSchema } from "./schema";

export const FILTERS_SCHEMA: JsonSchema = {
  type: "array", maxItems: 12,
  description: "Row filters, AND-combined. Use to restrict to a region, product, date range, value range, etc.",
  items: {
    type: "object",
    properties: {
      column: { type: "string", description: "Column name" },
      op: { type: "string", enum: ["eq", "neq", "in", "not_in", "contains", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"] },
      value: { description: "A single value (string, number or boolean)" },
      values: { type: "array", description: "For in / not_in / between (two values)" },
    },
    required: ["column", "op"],
  },
};

export const COMMON_PROPS: Record<string, JsonSchema> = {
  filters: FILTERS_SCHEMA,
  date_from: { type: "string", description: "Restrict to dates on or after this ISO date (YYYY-MM-DD), month (YYYY-MM), quarter (YYYY-Qn) or year (YYYY)." },
  date_to: { type: "string", description: "Restrict to dates on or before this ISO date, month, quarter or year." },
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/* ---------------------------- column resolution ---------------------------- */

const MEANING_ALIASES: Record<string, string> = {
  revenue: "revenue", sales: "revenue", turnover: "revenue", income: "revenue",
  profit: "profit", profits: "profit", earnings: "profit",
  cost: "cost", costs: "cost", expense: "cost", expenses: "cost", cogs: "cost",
  quantity: "quantity", qty: "quantity", units: "quantity", volume: "quantity",
  price: "price", prices: "price", discount: "discount", discounts: "discount",
  marketing: "marketing", "marketingspend": "marketing", adspend: "marketing",
  customer: "customer", customers: "customer", client: "customer", clients: "customer",
  product: "product", products: "product", item: "product", items: "product", sku: "product",
  region: "region", regions: "region", country: "region", state: "region", geography: "region",
  channel: "channel", channels: "channel", segment: "segment", segments: "segment", stage: "stage",
};

export interface ResolveOptions { kind?: "number" | "date" | "string" | "any"; allowMeaning?: boolean }

/** Resolves a user/LLM-supplied column reference to an exact column, or throws with the closest names. */
export function resolveColumn(ctx: AnalysisContext, ref: string, o: ResolveOptions = {}): ColumnProfile {
  const cols = ctx.profile.columns;
  const want = (c: ColumnProfile) => !o.kind || o.kind === "any" || c.physical === o.kind || (o.kind === "string" && c.physical === "boolean");
  const exact = cols.find((c) => c.name === ref);
  if (exact) return check(exact);
  const n = norm(ref);
  const ci = cols.filter((c) => norm(c.name) === n);
  if (ci.length === 1) return check(ci[0]!);
  if (o.allowMeaning !== false) {
    const meaning = MEANING_ALIASES[n];
    const caps = ctx.profile.capabilities as unknown as Record<string, string | null>;
    if (meaning && caps[meaning]) {
      const c = cols.find((x) => x.name === caps[meaning]);
      if (c && want(c)) return c;
    }
  }
  const partial = cols.filter((c) => want(c) && n.length >= 3 && (norm(c.name).startsWith(n) || norm(c.name).includes(n) || n.includes(norm(c.name)) && norm(c.name).length >= 4));
  if (partial.length === 1) return partial[0]!;
  const pool = cols.filter(want).map((c) => c.name);
  const near = pool.filter((c) => norm(c).includes(n.slice(0, 3)) || n.includes(norm(c).slice(0, 3))).slice(0, 6);
  throw new AnalyticsError(
    "unknown_column", `Column "${ref}" was not found${partial.length > 1 ? ` (it matches several columns: ${partial.map((c) => c.name).join(", ")})` : ""}.`,
    `${o.kind && o.kind !== "any" ? `${o.kind} ` : ""}columns available: ${(near.length ? near : pool).slice(0, 25).join(", ")}`,
  );
  function check(c: ColumnProfile): ColumnProfile {
    if (!want(c)) throw new AnalyticsError("wrong_type", `"${c.name}" is a ${c.physical} column; a ${o.kind} column is required here.`, `${o.kind} columns: ${cols.filter(want).map((x) => x.name).join(", ")}`);
    return c;
  }
}

export function resolveMeasure(ctx: AnalysisContext, ref: string | undefined | null, fallback?: "lead"): ColumnProfile {
  const name = ref ?? (fallback === "lead" ? ctx.profile.capabilities.leadMetric : null);
  if (!name) throw new AnalyticsError("invalid_argument", "A numeric metric column is required and none could be chosen automatically.", `numeric columns: ${ctx.profile.capabilities.measures.join(", ")}`);
  return resolveColumn(ctx, name, { kind: "number" });
}

export function resolveDimension(ctx: AnalysisContext, ref: string | undefined | null): ColumnProfile {
  if (!ref) throw new AnalyticsError("invalid_argument", "A dimension column is required.", `groupable columns: ${ctx.profile.capabilities.groupable.join(", ")}`);
  const c = resolveColumn(ctx, ref, { kind: "any" });
  if (c.physical === "number" && c.role === "measure") throw new AnalyticsError("wrong_type", `"${c.name}" is a numeric measure, not a category to group by.`, `groupable columns: ${ctx.profile.capabilities.groupable.join(", ")}`);
  return c;
}

/** Summing a rate, price, share or score is meaningless — reject rather than produce a number (safeguards 5, 8). */
export function assertAggAllowed(col: ColumnProfile, agg: string): void {
  if (agg === "sum" && col.additive === false) {
    throw new AnalyticsError("invalid_argument", `"${col.name}" is a ${col.meaning ?? "rate/share/price-like"} column, so its total is not meaningful.`, "Use avg, median, min or max instead.");
  }
}

/* ------------------------------- scoping ---------------------------------- */

export interface Scope { ctx: AnalysisContext; warnings: string[]; filters: Filter[] }

export function resolveFilters(ctx: AnalysisContext, raw: unknown): Filter[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const r = f as Record<string, unknown>;
    const col = resolveColumn(ctx, String(r.column), { kind: "any", allowMeaning: true });
    return { column: col.name, op: r.op as Filter["op"], value: r.value as Filter["value"], values: r.values as Filter["values"] };
  });
}

/** Applies user filters and the date_from/date_to shorthand on top of the active context. */
export function scopeFor(ctx: AnalysisContext, params: Record<string, unknown>): Scope {
  const filters = resolveFilters(ctx, params.filters);
  const dateCol = ctx.profile.primaryDate;
  const from = params.date_from as string | undefined, to = params.date_to as string | undefined;
  if (from || to) {
    if (!dateCol) throw new AnalyticsError("no_date_column", "A date range was requested but the dataset has no usable date column.");
    const a = from ? dateRangeFromKey(from) : null, b = to ? dateRangeFromKey(to) : null;
    if (from && !a) throw new AnalyticsError("invalid_argument", `"${from}" is not a valid date; use YYYY-MM-DD, YYYY-MM, YYYY-Qn or YYYY.`);
    if (to && !b) throw new AnalyticsError("invalid_argument", `"${to}" is not a valid date; use YYYY-MM-DD, YYYY-MM, YYYY-Qn or YYYY.`);
    if (a) filters.push({ column: dateCol, op: "gte", value: formatIsoDate(a[0]) });
    if (b) filters.push({ column: dateCol, op: "lte", value: formatIsoDate(b[1]) });
  }
  if (!filters.length) return { ctx, warnings: [], filters };
  const probe = applyFilters(ctx.frame, filters, ctx.rows);
  const scoped = narrow(ctx, filters);
  if (scoped.rowCount === 0) {
    const hints: string[] = [...probe.warnings];
    for (const f of filters) {
      const col = ctx.frame.get(f.column);
      if (col && col.kind === "string" && (f.op === "eq" || f.op === "in") && (f.value !== undefined || f.values)) {
        const v = String(f.value ?? f.values?.[0]);
        const near = closestValues(col as StringColumn, v);
        if (near.length) hints.push(`Closest values in "${f.column}" to "${v}": ${near.join(", ")}.`);
      }
    }
    throw new AnalyticsError("no_matching_rows", "No rows match those filters.", hints.join(" ") || "Loosen or remove a filter.");
  }
  return { ctx: scoped, warnings: probe.warnings, filters };
}

/* ------------------------------ result builder ------------------------------ */

export class Builder {
  readonly fs: FactSet;
  readonly caveats: string[] = [];
  constructor(readonly tool: string, readonly ctx: AnalysisContext, readonly params: Record<string, unknown>, warnings: string[] = []) {
    this.fs = new FactSet(ctx.fmt, "f");
    this.caveats.push(...warnings);
  }
  caveat(s: string | undefined | null): void { if (s && !this.caveats.includes(s)) this.caveats.push(s); }

  private periodOfRows(): { from: string; to: string } | null {
    const d = this.ctx.profile.primaryDate;
    if (!d) return null;
    try {
      const lo = aggregate(this.ctx, "min", d).value, hi = aggregate(this.ctx, "max", d).value;
      return lo === null || hi === null ? null : { from: formatIsoDate(lo), to: formatIsoDate(hi) };
    } catch { return null; }
  }

  done<T>(data: T, o: { summary: string; method: string; chart?: ChartSpec }): ToolResult<T> {
    return {
      ok: true, data, facts: this.fs.facts, summary: o.summary, chart: o.chart,
      provenance: {
        tool: this.tool, params: this.params, rowsConsidered: this.ctx.rowCount, filters: this.ctx.filterText,
        datasetVersion: this.ctx.datasetVersion, period: this.periodOfRows(), method: o.method, caveats: this.caveats,
      },
    };
  }
}

export function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? Math.round(v) : dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** Makes values JSON-safe (NaN/Infinity → null). */
export function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? null : x))) as T;
}

/* ------------------------------ period keys -------------------------------- */

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** "May 2026", "Q2 2026", "2026/05", "2026-5" → "2026-05" | "2026-Q2"; ISO dates and years pass through. */
export function normalizePeriodKey(text: string): string | null {
  const s = String(text).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{4})-W(\d{2})$/i.exec(s);
  if (m) return `${m[1]}-W${m[2]}`;
  m = /^(\d{4})[-/](\d{1,2})$/.exec(s);
  if (m && +m[2]! >= 1 && +m[2]! <= 12) return `${m[1]}-${String(m[2]).padStart(2, "0")}`;
  m = /^(\d{4})[- ]?Q([1-4])$/i.exec(s) ?? /^Q([1-4])[- ]?(\d{4})$/i.exec(s);
  if (m) { const q = /^Q/i.test(s) ? m[1]! : m[2]!, y = /^Q/i.test(s) ? m[2]! : m[1]!; return `${y}-Q${q}`; }
  if (/^\d{4}$/.test(s)) return s;
  m = /^([A-Za-z]+)\.?[ ,-]+(\d{4})$/.exec(s);
  if (m && MONTH_INDEX[m[1]!.toLowerCase()]) return `${m[2]}-${String(MONTH_INDEX[m[1]!.toLowerCase()]).padStart(2, "0")}`;
  m = /^(\d{4})[ ,-]+([A-Za-z]+)$/.exec(s);
  if (m && MONTH_INDEX[m[2]!.toLowerCase()]) return `${m[1]}-${String(MONTH_INDEX[m[2]!.toLowerCase()]).padStart(2, "0")}`;
  return null;
}
