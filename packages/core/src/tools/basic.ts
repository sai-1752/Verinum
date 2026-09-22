import { AnalyticsError } from "../analytics/errors";
import { aggregateColumn, type AggName } from "../analytics/aggregate";
import { closestValues } from "../analytics/filter";
import { crossTab, groupBy, BLANK } from "../analytics/groupby";
import { groupsToReach } from "../analytics/concentration";
import { histogram, numStats } from "../stats";
import { formatIsoDate } from "../time";
import { metricSpec, type AnalysisContext } from "../context";
import type { ChartSpec } from "../charts";
import type { Unit } from "../format";
import type { StringColumn } from "../frame";
import type { ColumnProfile } from "../types";
import { Builder, clampInt, COMMON_PROPS, assertAggAllowed, jsonSafe, resolveColumn, resolveDimension, resolveMeasure, scopeFor } from "./helpers";
import type { ToolDef } from "./registry";

/* ------------------------------ metric selection ---------------------------- */

export interface PickedMetric {
  column: ColumnProfile | null;
  agg: AggName;
  label: string;
  unit: Unit;
  scale: number;
  additive: boolean;
}

const AGG_ENUM = ["sum", "avg", "count", "distinct_count", "min", "max", "median", "std", "percentile"] as const;

export function pickMetric(ctx: AnalysisContext, params: Record<string, unknown>): PickedMetric {
  const ref = params.metric as string | undefined;
  const agg = params.agg as AggName | undefined;
  if (!ref) {
    if (agg === "count") return { column: null, agg: "count", label: "Rows", unit: "count", scale: 1, additive: true };
    if (agg === "distinct_count") throw new AnalyticsError("invalid_argument", "distinct_count needs a column (for example the customer or product column).");
    const lead = ctx.profile.capabilities.leadMetric;
    if (!lead) {
      if (!agg) return { column: null, agg: "count", label: "Rows", unit: "count", scale: 1, additive: true };
      throw new AnalyticsError("invalid_argument", "A numeric metric column is required.", `numeric columns: ${ctx.profile.capabilities.measures.join(", ")}`);
    }
    return pickMetric(ctx, { ...params, metric: lead });
  }
  const col = resolveColumn(ctx, ref, { kind: "any" });
  if (agg === "count" || agg === "distinct_count") {
    return { column: col, agg, label: agg === "count" ? `Count of ${col.name}` : `Distinct ${col.name}`, unit: "count", scale: 1, additive: agg === "count" };
  }
  if (col.physical !== "number") throw new AnalyticsError("wrong_type", `"${col.name}" is a ${col.physical} column; use agg "count" or "distinct_count" for it, or choose a numeric metric.`, `numeric columns: ${ctx.profile.capabilities.measures.join(", ")}`);
  const spec = metricSpec(ctx, col.name);
  const chosen: AggName = agg ?? spec.agg;
  assertAggAllowed(col, chosen);
  const word = chosen === "sum" ? "Total" : chosen === "avg" ? "Average" : chosen === "median" ? "Median" : chosen === "min" ? "Minimum" : chosen === "max" ? "Maximum" : chosen === "std" ? "Std dev of" : "Percentile of";
  return { column: col, agg: chosen, label: `${word} ${col.name}`, unit: spec.unit, scale: spec.scale, additive: chosen === "sum" };
}

const METRIC_PROPS = {
  metric: { type: "string", description: "Numeric column to measure (or any column for count / distinct_count). Omit to use the dataset's lead metric (e.g. revenue)." },
  agg: { type: "string", enum: AGG_ENUM, description: "Aggregation. Defaults to sum for additive measures and avg for prices, rates and shares. Summing a price/rate/share is rejected." },
  percentile: { type: "number", minimum: 0, maximum: 100, description: "Percentile (0–100) when agg=percentile" },
} as const;

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/* ------------------------------- dataset tools ------------------------------ */

const describeDataset: ToolDef = {
  name: "describe_dataset",
  description: "Overview of the dataset: number of rows, columns and their meanings, date coverage, data-quality score and issues, and which analyses are available or unavailable (with reasons). Call this first for open-ended questions.",
  parameters: { properties: {} },
  run(ctx) {
    const p = ctx.profile;
    const b = new Builder("describe_dataset", ctx, {});
    const rows = b.fs.num("Rows", p.rowCount, "count"), cols = b.fs.num("Columns", p.columnCount, "count");
    const q = b.fs.num("Data quality score", p.quality.score, "count");
    const cal = p.calendar;
    let range = "";
    if (cal) {
      const from = b.fs.text("First date", formatIsoDate(cal.minDay), "date"), to = b.fs.text("Last date", formatIsoDate(cal.maxDay), "date");
      const cp = b.fs.num("Complete periods", cal.completePeriods, "count");
      range = ` ${p.primaryDate} runs from ${from.display} to ${to.display} (${cp.display} complete ${cal.grain}s).`;
      for (const n of cal.notes) b.caveat(n);
    }
    const dup = b.fs.num("Duplicate rows", p.duplicateRows, "count");
    const data = jsonSafe({
      rows: p.rowCount, columns: p.columns.map((c) => ({ name: c.name, type: c.type, role: c.role, meaning: c.meaning, missingPct: Math.round(c.missingPct * 10) / 10, distinct: c.distinct, additive: c.additive, unit: c.unit, chartDimension: c.chartDimension })),
      primaryDate: p.primaryDate, calendar: cal, leadMetric: p.capabilities.leadMetric, domain: p.domain, currency: p.currency,
      quality: { score: p.quality.score, label: p.quality.label, counts: p.quality.counts, issues: p.quality.issues.slice(0, 8).map((i) => ({ severity: i.severity, kind: i.kind, column: i.column, detail: i.detail })) },
      available: Object.entries(p.capabilities).filter(([k, v]) => typeof v === "boolean" && v && k !== "hasData").map(([k]) => k),
      unavailable: p.capabilities.unavailable,
    });
    return b.done(data, {
      summary: `The dataset has ${rows.display} rows and ${cols.display} columns.${range} Data quality is ${p.quality.label.toLowerCase()} (score ${q.display}); ${dup.display} rows are exact duplicates.`,
      method: "Column types, meanings and quality were determined at ingestion from values, names and arithmetic relationships between columns.",
    });
  },
};

const describeColumn: ToolDef = {
  name: "describe_column",
  description: "Profile of one column: type, business meaning, whether it can be summed, missing values, distinct values, and summary statistics or top values.",
  parameters: { properties: { column: { type: "string" } }, required: ["column"] },
  run(ctx, p) {
    const c = resolveColumn(ctx, p.column as string, { kind: "any" });
    const b = new Builder("describe_column", ctx, { column: c.name });
    const cnt = b.fs.num(`${c.name}: values present`, c.count, "count"), miss = b.fs.num(`${c.name}: missing`, c.missing, "count"), dist = b.fs.num(`${c.name}: distinct values`, c.distinct, "count");
    let extra = "";
    if (c.stats) {
      const spec = metricSpec(ctx, c.name);
      const mn = b.fs.num("Minimum", c.stats.min * spec.scale, spec.unit), mx = b.fs.num("Maximum", c.stats.max * spec.scale, spec.unit);
      const md = b.fs.num("Median", c.stats.median * spec.scale, spec.unit), av = b.fs.num("Mean", c.stats.mean * spec.scale, spec.unit);
      extra = ` Min ${mn.display}, median ${md.display}, mean ${av.display}, max ${mx.display}.`;
    }
    if (c.date) extra = ` Dates run ${c.date.minIso} to ${c.date.maxIso}.`;
    b.caveat(c.additive === false ? `"${c.name}" is not additive (${c.meaning ?? "a rate, price or share"}), so it is averaged rather than summed.` : null);
    const data = jsonSafe({ name: c.name, type: c.type, role: c.role, meaning: c.meaning, subtypes: c.subtypes, reasons: c.reasons, additive: c.additive, defaultAgg: c.defaultAgg, unit: c.unit, stats: c.stats, top: c.top?.slice(0, 10), date: c.date });
    return b.done(data, { summary: `"${c.name}" is a ${c.type} column with ${cnt.display} values, ${miss.display} missing and ${dist.display} distinct.${extra}`, method: "Profile computed at ingestion." });
  },
};

const listValues: ToolDef = {
  name: "list_values",
  description: "Most frequent values of a categorical column with counts. Use it to see what categories exist or to find the exact spelling of a value.",
  parameters: { properties: { column: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, contains: { type: "string", description: "Only values containing this text" }, ...COMMON_PROPS }, required: ["column"] },
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const c = resolveColumn(sc.ctx, p.column as string, { kind: "any" });
    if (c.physical === "number" && c.role === "measure") throw new AnalyticsError("wrong_type", `"${c.name}" is a numeric measure; use describe_column or distribution.`);
    const b = new Builder("list_values", sc.ctx, { column: c.name, limit: p.limit, contains: p.contains }, sc.warnings);
    const limit = clampInt(p.limit, 1, 100, 20);
    const g = groupBy(sc.ctx.frame, sc.ctx.rows, { dimension: c.name, agg: "count" });
    let groups = g.groups.filter((x) => !x.isBlank);
    if (p.contains) groups = groups.filter((x) => x.key.toLowerCase().includes(String(p.contains).toLowerCase()));
    const total = groups.reduce((s, x) => s + x.value, 0);
    const shown = groups.slice(0, limit);
    const d = b.fs.num(`Distinct ${c.name} values${p.contains ? " matching" : ""}`, groups.length, "count");
    const rows = shown.map((x) => {
      const n = b.fs.num(`${x.key}: rows`, x.value, "count");
      const sh = b.fs.num(`${x.key}: share of rows`, total ? (x.value / total) * 100 : 0, "percent");
      return { value: x.key, rows: x.value, rowsDisplay: n.display, share: sh.value, shareDisplay: sh.display };
    });
    if (g.blankRows) b.caveat(`${b.fs.num("Blank rows", g.blankRows, "count").display} rows have no ${c.name} value.`);
    return b.done(jsonSafe({ column: c.name, distinct: groups.length, values: rows }), {
      summary: `"${c.name}" has ${d.display} distinct values; the most frequent is ${shown[0]?.key ?? "none"}.`,
      method: "Rows are counted per distinct value.",
    });
  },
};

const findValue: ToolDef = {
  name: "find_value",
  description: "Find the closest existing values in a column to a name the user typed (fixes spelling, casing and partial names) before filtering on it.",
  parameters: { properties: { column: { type: "string" }, query: { type: "string" } }, required: ["column", "query"] },
  run(ctx, p) {
    const c = resolveColumn(ctx, p.column as string, { kind: "string" });
    const col = ctx.frame.string(c.name) as StringColumn;
    const near = closestValues(col, p.query as string, 8);
    const b = new Builder("find_value", ctx, { column: c.name, query: p.query });
    const n = b.fs.num("Matches found", near.length, "count");
    return b.done({ column: c.name, query: p.query, matches: near }, { summary: near.length ? `Found ${n.display} close match${near.length === 1 ? "" : "es"} in "${c.name}": ${near.join(", ")}.` : `No value in "${c.name}" is close to "${p.query}".`, method: "Case-insensitive substring match, then small edit distance." });
  },
};

/* --------------------------------- aggregate -------------------------------- */

const aggregateTool: ToolDef = {
  name: "aggregate",
  description: "A single number: total, average, count, distinct count, min, max, median, std or percentile of a column, optionally filtered (by segment, product, date range, etc.). Use agg=count with no metric for the number of rows. Never sums prices, rates or shares.",
  parameters: { properties: { ...METRIC_PROPS, ...COMMON_PROPS } },
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const m = pickMetric(sc.ctx, p);
    const b = new Builder("aggregate", sc.ctx, { metric: m.column?.name ?? null, agg: m.agg, ...(p.percentile !== undefined ? { percentile: p.percentile } : {}), filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const r = aggregateColumn(sc.ctx.frame, sc.ctx.rows, m.agg, m.column?.name, typeof p.percentile === "number" ? p.percentile : 50);
    if (r.value === null) throw new AnalyticsError("insufficient_data", `"${m.column?.name}" has no values in the selected rows.`);
    const v = r.value * m.scale;
    const f = b.fs.num(m.label, v, m.unit);
    const n = b.fs.num("Values used", r.n, "count");
    if (r.blanks) b.caveat(`${b.fs.num("Blank values", r.blanks, "count").display} rows have no ${m.column?.name} value and are excluded.`);
    const scope = sc.ctx.filterText.length ? ` (${sc.ctx.filterText.join("; ")})` : "";
    return b.done({ label: m.label, value: v, display: f.display, valuesUsed: r.n, blanks: r.blanks, rowsConsidered: r.rowsConsidered }, {
      summary: `${m.label}${scope}: ${f.display}, from ${n.display} values.`,
      method: `${m.agg.toUpperCase()} over ${r.rowsConsidered.toLocaleString("en-US")} rows${sc.ctx.filterText.length ? " after filters" : ""}; blank values are excluded, never treated as zero.`,
    });
  },
};

/* ------------------------------ ranking / grouping -------------------------- */

function runGroup(tool: string, ctx: AnalysisContext, p: Record<string, unknown>) {
  const sc = scopeFor(ctx, p);
  const dim = resolveDimension(sc.ctx, p.dimension as string);
  if (dim.physical === "date") throw new AnalyticsError("wrong_type", `"${dim.name}" is a date column; use time_series to group by period.`);
  const m = pickMetric(sc.ctx, p);
  const limit = clampInt(p.limit ?? p.n, 1, 50, tool === "top_n" ? 5 : 10);
  const order = p.order === "asc" ? "asc" : "desc";
  const params = { dimension: dim.name, metric: m.column?.name ?? null, agg: m.agg, limit, order, ...(p.min_rows ? { min_rows: p.min_rows } : {}), filters: p.filters, date_from: p.date_from, date_to: p.date_to };
  const b = new Builder(tool, sc.ctx, params, sc.warnings);
  const g = groupBy(sc.ctx.frame, sc.ctx.rows, { dimension: dim.name, metric: m.column?.name, agg: m.agg, percentile: typeof p.percentile === "number" ? p.percentile : undefined, order });
  const additive = m.agg === "sum" || m.agg === "count";
  const minRows = clampInt(p.min_rows, 1, 10_000, additive ? 1 : 5);
  let groups = g.groups.filter((x) => !x.isBlank);
  const dropped = groups.filter((x) => x.rows < minRows).length;
  groups = groups.filter((x) => x.rows >= minRows);
  if (!groups.length) throw new AnalyticsError("insufficient_data", `No ${dim.name} group has enough rows (at least ${minRows}) to rank.`);
  const total = additive ? groups.reduce((s, x) => s + x.value, 0) : null;
  const shown = groups.slice(0, limit);
  const blankRow = g.groups.find((x) => x.isBlank);
  if (blankRow) b.caveat(`${b.fs.num("Rows without a value", blankRow.rows, "count").display} rows have no ${dim.name} and are excluded from the ranking${additive ? "; shares are of the ranked rows" : ""}.`);
  if (dropped) b.caveat(`${b.fs.num("Groups excluded (too few rows)", dropped, "count").display} ${dim.name} values with fewer than ${b.fs.num("Minimum rows per group", minRows, "count").display} rows were excluded from this ranking.`);
  const kf = b.fs.num(`Distinct ${dim.name} values ranked`, groups.length, "count");
  const lf = b.fs.num("Groups shown", shown.length, "count");
  const rowsOut = shown.map((x, i) => {
    const v = x.value * m.scale;
    const vf = b.fs.num(`${x.key}: ${m.label}`, v, m.unit);
    const sh = total && total > 0 ? b.fs.num(`${x.key}: share of ${m.label}`, (Math.max(0, x.value) / total) * 100, "percent") : null;
    return { rank: i + 1, key: x.key, value: v, display: vf.display, share: sh?.value ?? null, shareDisplay: sh?.display ?? null, rows: x.rows };
  });
  if (total !== null && total > 0) {
    const cum = shown.reduce((s, x) => s + Math.max(0, x.value), 0);
    b.fs.num(`Combined share of the ${shown.length} shown`, (cum / total) * 100, "percent");
  }
  const chart: ChartSpec = { kind: "bar", title: `${m.label} by ${dim.name}`, unit: m.unit, currency: ctx.fmt.currency, horizontal: true, categories: rowsOut.map((r) => r.key), values: rowsOut.map((r) => r.value), annotations: rowsOut.map((r) => r.shareDisplay ?? "") };
  const lines = rowsOut.map((r) => `${r.rank}. ${r.key} — ${r.display}${r.shareDisplay ? ` (${r.shareDisplay} of the total)` : ""}`);
  const head = order === "asc" ? "Bottom" : "Top";
  return b.done(jsonSafe({ dimension: dim.name, metric: m.column?.name ?? null, agg: m.agg, label: m.label, order, groupsRanked: groups.length, rows: rowsOut }), {
    summary: `${head} ${lf.display} ${dim.name} values by ${m.label} (of ${kf.display}):\n${lines.join("\n")}`,
    method: `${m.agg.toUpperCase()} of ${m.column?.name ?? "rows"} per ${dim.name}, sorted ${order === "asc" ? "ascending" : "descending"}; blank ${dim.name} values are excluded.`,
    chart,
  });
}

const GROUP_PROPS = {
  dimension: { type: "string", description: "Column to group by (e.g. Product, Region, Customer)" },
  ...METRIC_PROPS,
  limit: { type: "integer", minimum: 1, maximum: 50, description: "Number of groups to return" },
  order: { type: "string", enum: ["desc", "asc"], description: "desc = highest first (default), asc = lowest first" },
  min_rows: { type: "integer", minimum: 1, description: "Ignore groups with fewer rows (default 5 for averages, 1 for totals)" },
  ...COMMON_PROPS,
} as const;

const groupByTool: ToolDef = {
  name: "group_by",
  description: "Aggregate a metric per category (sales by region, average price by product, count of rows by channel), ranked. Returns each group's value and share of the total (for additive metrics). Blank categories are excluded and reported.",
  parameters: { properties: GROUP_PROPS, required: ["dimension"] },
  run: (ctx, p) => runGroup("group_by", ctx, p),
};

const topN: ToolDef = {
  name: "top_n",
  description: "The top (or bottom) N categories by a metric — 'top 5 products by revenue', 'worst 3 regions by profit', 'most frequent channels'. Defaults to N=5 and the lead metric.",
  parameters: { properties: { ...GROUP_PROPS, n: { type: "integer", minimum: 1, maximum: 50, description: "How many to return (default 5)" } }, required: ["dimension"] },
  run: (ctx, p) => runGroup("top_n", ctx, p),
};

const shareOfTotal: ToolDef = {
  name: "share_of_total",
  description: "What share of the total (sales, rows, profit…) belongs to one specific value — e.g. 'what share of sales comes from Enterprise?'.",
  parameters: { properties: { dimension: { type: "string" }, value: { type: "string", description: "The category value" }, ...METRIC_PROPS, ...COMMON_PROPS }, required: ["dimension", "value"] },
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const dim = resolveDimension(sc.ctx, p.dimension as string);
    const m = pickMetric(sc.ctx, p);
    if (!(m.agg === "sum" || m.agg === "count")) throw new AnalyticsError("invalid_argument", "A share of the total is only meaningful for totals and counts.", "Use agg=sum or agg=count.");
    const b = new Builder("share_of_total", sc.ctx, { dimension: dim.name, value: p.value, metric: m.column?.name ?? null, agg: m.agg, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const g = groupBy(sc.ctx.frame, sc.ctx.rows, { dimension: dim.name, metric: m.column?.name, agg: m.agg });
    const real = g.groups.filter((x) => !x.isBlank);
    const total = real.reduce((s, x) => s + Math.max(0, x.value), 0);
    const hit = real.find((x) => x.key.toLowerCase() === String(p.value).toLowerCase());
    if (!hit) {
      const col = sc.ctx.frame.get(dim.name);
      const near = col && col.kind === "string" ? closestValues(col, String(p.value)) : [];
      throw new AnalyticsError("no_matching_rows", `"${p.value}" is not a value of ${dim.name}.`, near.length ? `Closest values: ${near.join(", ")}` : undefined);
    }
    const share = total > 0 ? (Math.max(0, hit.value) / total) * 100 : 0;
    const rank = real.findIndex((x) => x.key === hit.key) + 1;
    const vf = b.fs.num(`${hit.key}: ${m.label}`, hit.value * m.scale, m.unit);
    const sf = b.fs.num(`${hit.key}: share of ${m.label}`, share, "percent");
    const tf = b.fs.num(`Total ${m.label}`, total * m.scale, m.unit);
    const rf = b.fs.num(`${hit.key}: rank among ${dim.name} values`, rank, "count"), kf = b.fs.num(`Distinct ${dim.name} values`, real.length, "count");
    return b.done(jsonSafe({ dimension: dim.name, key: hit.key, value: hit.value * m.scale, share, rank, of: real.length, total: total * m.scale }), {
      summary: `${hit.key} accounts for ${sf.display} of ${m.label} (${vf.display} of ${tf.display}), ranking ${rf.display} of ${kf.display} ${dim.name} values.`,
      method: `${m.agg.toUpperCase()} per ${dim.name}; share = group ÷ sum of ranked groups.`,
    });
  },
};

const compareGroups: ToolDef = {
  name: "compare_groups",
  description: "Compare two categories on a metric (e.g. North vs South revenue): both values, the difference and the ratio.",
  parameters: { properties: { dimension: { type: "string" }, group_a: { type: "string" }, group_b: { type: "string" }, ...METRIC_PROPS, ...COMMON_PROPS }, required: ["dimension", "group_a", "group_b"] },
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const dim = resolveDimension(sc.ctx, p.dimension as string);
    const m = pickMetric(sc.ctx, p);
    const b = new Builder("compare_groups", sc.ctx, { dimension: dim.name, group_a: p.group_a, group_b: p.group_b, metric: m.column?.name ?? null, agg: m.agg, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const g = groupBy(sc.ctx.frame, sc.ctx.rows, { dimension: dim.name, metric: m.column?.name, agg: m.agg });
    const find = (v: unknown) => {
      const hit = g.groups.find((x) => !x.isBlank && x.key.toLowerCase() === String(v).toLowerCase());
      if (!hit) {
        const col = sc.ctx.frame.get(dim.name);
        const near = col && col.kind === "string" ? closestValues(col, String(v)) : [];
        throw new AnalyticsError("no_matching_rows", `"${v}" is not a value of ${dim.name}.`, near.length ? `Closest values: ${near.join(", ")}` : undefined);
      }
      return hit;
    };
    const A = find(p.group_a), B = find(p.group_b);
    const va = A.value * m.scale, vb = B.value * m.scale;
    const fa = b.fs.num(`${A.key}: ${m.label}`, va, m.unit), fb = b.fs.num(`${B.key}: ${m.label}`, vb, m.unit);
    const diff = b.fs.num("Difference (A − B)", va - vb, m.unit, { signed: true });
    const ratio = vb !== 0 ? b.fs.num("Ratio A ÷ B", va / vb, "ratio") : null;
    const pct = vb !== 0 ? b.fs.num("A relative to B", ((va - vb) / Math.abs(vb)) * 100, "percent", { signed: true }) : null;
    return b.done(jsonSafe({ dimension: dim.name, a: { key: A.key, value: va, rows: A.rows }, b: { key: B.key, value: vb, rows: B.rows }, difference: va - vb, ratio: vb !== 0 ? va / vb : null }), {
      summary: `${A.key}: ${fa.display}; ${B.key}: ${fb.display} (${m.label}). Difference ${diff.display}${pct ? `, ${pct.display} relative to ${B.key}` : ""}${ratio ? `, ratio ${ratio.display}` : ""}.`,
      method: `${m.agg.toUpperCase()} of the metric within each group.`,
    });
  },
};

const crossTabTool: ToolDef = {
  name: "cross_tab",
  description: "A two-way table: a metric broken down by two categories at once (e.g. sales by region × channel). Limited to the 12 largest of each.",
  parameters: { properties: { row_dimension: { type: "string" }, column_dimension: { type: "string" }, ...METRIC_PROPS, ...COMMON_PROPS }, required: ["row_dimension", "column_dimension"] },
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const da = resolveDimension(sc.ctx, p.row_dimension as string), db = resolveDimension(sc.ctx, p.column_dimension as string);
    const m = pickMetric(sc.ctx, p);
    if (!["sum", "avg", "count"].includes(m.agg)) throw new AnalyticsError("invalid_argument", "A cross-tab supports sum, avg or count.");
    const b = new Builder("cross_tab", sc.ctx, { row_dimension: da.name, column_dimension: db.name, metric: m.column?.name ?? null, agg: m.agg, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const ct = crossTab(sc.ctx.frame, sc.ctx.rows, { dimensionA: da.name, dimensionB: db.name, metric: m.column?.name, agg: m.agg as "sum" | "avg" | "count" });
    const cells = ct.cells.slice(0, 40);
    const rowsOut = cells.map((c) => { const f = b.fs.num(`${c.a} × ${c.b}: ${m.label}`, c.value * m.scale, m.unit); return { row: c.a, column: c.b, value: c.value * m.scale, display: f.display, n: c.n }; });
    const top = cells[0];
    const ri = new Map(ct.aLabels.map((l, i) => [l, i])), ci = new Map(ct.bLabels.map((l, i) => [l, i]));
    const matrix: (number | null)[][] = ct.aLabels.map(() => ct.bLabels.map(() => null));
    for (const c of ct.cells) { const r = ri.get(c.a), k = ci.get(c.b); if (r !== undefined && k !== undefined) matrix[r]![k] = c.value * m.scale; }
    const chart: ChartSpec = { kind: "heatmap", title: `${m.label} by ${da.name} × ${db.name}`, unit: m.unit, currency: ctx.fmt.currency, rows: ct.aLabels, columns: ct.bLabels, values: matrix };
    return b.done(jsonSafe({ rowDimension: da.name, columnDimension: db.name, label: m.label, rowLabels: ct.aLabels, columnLabels: ct.bLabels, cells: rowsOut }), {
      summary: top ? `${m.label} by ${da.name} × ${db.name}: the largest cell is ${top.a} × ${top.b} at ${rowsOut[0]!.display}.` : "No cells.",
      method: `${m.agg.toUpperCase()} per combination; only the largest categories of each dimension are shown.`, chart,
    });
  },
};

const pareto: ToolDef = {
  name: "pareto",
  description: "How concentrated a total is: how many categories (products, customers…) it takes to reach 50% and 80% of a metric.",
  parameters: { properties: { dimension: { type: "string" }, ...METRIC_PROPS, ...COMMON_PROPS }, required: ["dimension"] },
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const dim = resolveDimension(sc.ctx, p.dimension as string);
    const m = pickMetric(sc.ctx, p);
    if (!(m.agg === "sum" || m.agg === "count")) throw new AnalyticsError("invalid_argument", "Pareto analysis needs a total or a count.");
    const b = new Builder("pareto", sc.ctx, { dimension: dim.name, metric: m.column?.name ?? null, agg: m.agg, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const g = groupBy(sc.ctx.frame, sc.ctx.rows, { dimension: dim.name, metric: m.column?.name, agg: m.agg });
    const vals = g.groups.filter((x) => !x.isBlank).map((x) => x.value);
    if (vals.length < 2) throw new AnalyticsError("insufficient_data", `${dim.name} has fewer than two groups.`);
    const n50 = groupsToReach(vals, 50), n80 = groupsToReach(vals, 80);
    const k = vals.length;
    const f50 = b.fs.num(`${dim.name} values to reach 50%`, n50, "count"), f80 = b.fs.num(`${dim.name} values to reach 80%`, n80, "count"), fk = b.fs.num(`Distinct ${dim.name} values`, k, "count");
    const p80 = b.fs.num(`Share of ${dim.name} values needed for 80%`, (n80 / k) * 100, "percent");
    const t50 = b.fs.num("Threshold", 50, "percent"), t80 = b.fs.num("Threshold", 80, "percent");
    return b.done({ dimension: dim.name, groups: k, to50: n50, to80: n80, shareOfGroupsFor80: (n80 / k) * 100 }, {
      summary: `The top ${f50.display} of ${fk.display} ${dim.name} values make up ${t50.display} of ${m.label}, and the top ${f80.display} (${p80.display} of them) make up ${t80.display}.`,
      method: "Groups are sorted by value and accumulated until each threshold is reached.",
    });
  },
};

/* ---------------------------------- distribution ---------------------------- */

const distribution: ToolDef = {
  name: "distribution",
  description: "The distribution of a numeric column: min, quartiles, median, mean, max, standard deviation and a histogram.",
  parameters: { properties: { column: { type: "string" }, bins: { type: "integer", minimum: 4, maximum: 40, default: 20 }, ...COMMON_PROPS }, required: ["column"] },
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const col = resolveMeasure(sc.ctx, p.column as string);
    const spec = metricSpec(sc.ctx, col.name);
    const b = new Builder("distribution", sc.ctx, { column: col.name, bins: p.bins, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const nc = sc.ctx.frame.number(col.name);
    const vals: number[] = [];
    for (let k = 0; k < (sc.ctx.rows ? sc.ctx.rows.length : sc.ctx.frame.rowCount); k++) { const v = nc.values[sc.ctx.rows ? sc.ctx.rows[k]! : k]!; if (v === v) vals.push(v); }
    if (vals.length < 2) throw new AnalyticsError("insufficient_data", `"${col.name}" has too few values.`);
    const st = numStats(vals);
    const s = spec.scale;
    const f = (l: string, v: number) => b.fs.num(l, v * s, spec.unit);
    const mn = f("Minimum", st.min), q1 = f("25th percentile", st.q1), md = f("Median", st.median), mean = f("Mean", st.mean), q3 = f("75th percentile", st.q3), mx = f("Maximum", st.max);
    const sd = f("Standard deviation", st.std);
    const cnt = b.fs.num("Values", st.count, "count");
    const out = b.fs.num("Values outside the IQR fences", st.outlierCount, "count");
    const hist = histogram(vals, st, clampInt(p.bins, 4, 40, 20));
    const chart: ChartSpec = { kind: "histogram", title: `Distribution of ${col.name}`, unit: spec.unit, currency: ctx.fmt.currency, bins: hist.map((h) => ({ x0: h.x0 * s, x1: h.x1 * s, n: h.n })) };
    return b.done(jsonSafe({ column: col.name, count: st.count, min: st.min * s, q1: st.q1 * s, median: st.median * s, mean: st.mean * s, q3: st.q3 * s, max: st.max * s, std: st.std * s, skew: st.skew, outliers: st.outlierCount, histogram: hist }), {
      summary: `${col.name} across ${cnt.display} values: minimum ${mn.display}, 25th percentile ${q1.display}, median ${md.display}, mean ${mean.display}, 75th percentile ${q3.display}, maximum ${mx.display} (standard deviation ${sd.display}); ${out.display} values fall outside the interquartile-range fences.`,
      method: "Quartiles by linear interpolation; outliers by the Tukey 1.5 × IQR rule.", chart,
    });
  },
};

export const BASIC_TOOLS: ToolDef[] = [describeDataset, describeColumn, listValues, findValue, aggregateTool, groupByTool, topN, shareOfTotal, compareGroups, crossTabTool, pareto, distribution];
export { list as _list, BLANK as _BLANK, aggregateColumn as _agg };
