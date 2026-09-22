import { AnalyticsError } from "../analytics/errors";
import { correlate, correlationPairs } from "../analytics/correlation";
import { cohortAnalysis, customerAnalysis, funnelAnalysis } from "../analytics/entities";
import { detectOutliers } from "../analytics/outliers";
import { profitabilityAnalysis } from "../analytics/profitability";
import { metricSpec, seriesFor, type AnalysisContext } from "../context";
import type { ChartSpec } from "../charts";
import { structuralCorrelationReason } from "../insights/generators";
import { Builder, COMMON_PROPS, clampInt, jsonSafe, resolveColumn, resolveDimension, resolveMeasure, scopeFor } from "./helpers";
import { pickMetric } from "./basic";
import type { ToolDef } from "./registry";
import type { Grain } from "../time";

const strength = (r: number) => (Math.abs(r) >= 0.7 ? "strong" : Math.abs(r) >= 0.4 ? "moderate" : "weak");

/* --------------------------------- profitability ----------------------------- */

const profitability: ToolDef = {
  name: "profitability",
  description: "Margin analysis: overall profit margin (SUM profit ÷ SUM revenue) and, per category, revenue, profit, margin and their shares; flags loss-making categories and those that bring in a lot of revenue but little profit.",
  parameters: { properties: { dimension: { type: "string", description: "Category to break down by (e.g. Product, Region). Omit for the overall margin." }, limit: { type: "integer", minimum: 1, maximum: 30, default: 10 }, ...COMMON_PROPS } },
  gate: (ctx) => (ctx.profile.capabilities.margin ? null : ctx.profile.capabilities.unavailable.margin ?? "Margin analysis isn't available."),
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const caps = sc.ctx.profile.capabilities;
    const rev = metricSpec(sc.ctx, caps.revenue!), prof = metricSpec(sc.ctx, caps.profit!);
    const dim = p.dimension ? resolveDimension(sc.ctx, p.dimension as string) : null;
    const b = new Builder("profitability", sc.ctx, { dimension: dim?.name ?? null, limit: p.limit, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const r = profitabilityAnalysis(sc.ctx.frame, sc.ctx.rows, { revenue: caps.revenue!, profit: caps.profit!, dimension: dim?.name });
    if (r.overall.margin === null) throw new AnalyticsError("insufficient_data", "Revenue is zero, so margin is undefined.");
    const om = b.fs.num("Overall margin", r.overall.margin, "percent"), orv = b.fs.num(`Total ${caps.revenue}`, r.overall.revenue * rev.scale, rev.unit), opf = b.fs.num(`Total ${caps.profit}`, r.overall.profit * prof.scale, prof.unit);
    let summary = `Overall: ${caps.revenue} ${orv.display}, ${caps.profit} ${opf.display}, margin ${om.display}.`;
    const limit = clampInt(p.limit, 1, 30, 10);
    const groups = r.groups.filter((g) => !g.isBlank).slice(0, limit).map((g) => {
      const rf = b.fs.num(`${g.key}: ${caps.revenue}`, g.revenue * rev.scale, rev.unit), pf = b.fs.num(`${g.key}: ${caps.profit}`, g.profit * prof.scale, prof.unit);
      const mf = g.margin !== null ? b.fs.num(`${g.key}: margin`, g.margin, "percent") : null;
      const rs = b.fs.num(`${g.key}: share of ${caps.revenue}`, g.revenueShare, "percent"), ps = b.fs.num(`${g.key}: share of ${caps.profit}`, g.profitShare, "percent");
      return { key: g.key, revenue: g.revenue * rev.scale, revenueDisplay: rf.display, profit: g.profit * prof.scale, profitDisplay: pf.display, margin: g.margin, marginDisplay: mf?.display ?? null, revenueShare: g.revenueShare, revenueShareDisplay: rs.display, profitShare: g.profitShare, profitShareDisplay: ps.display, lossMaking: g.lossMaking };
    });
    if (dim && groups.length) {
      const lines = groups.slice(0, 5).map((g, i) => `${i + 1}. ${g.key} — ${caps.revenue} ${g.revenueDisplay}, ${caps.profit} ${g.profitDisplay}, margin ${g.marginDisplay ?? "n/a"}`);
      summary += `\nBy ${dim.name} (by ${caps.revenue}):\n${lines.join("\n")}`;
      if (r.lossMakers.length) { const n = b.fs.num("Loss-making groups", r.lossMakers.length, "count"); summary += `\n${n.display} ${dim.name} value${r.lossMakers.length === 1 ? " is" : "s are"} loss-making: ${r.lossMakers.slice(0, 5).map((g) => g.key).join(", ")}.`; }
      if (r.highRevenueLowMargin.length) summary += `\nHigh revenue but low margin: ${r.highRevenueLowMargin.slice(0, 3).map((g) => g.key).join(", ")}.`;
    }
    const chart: ChartSpec | undefined = dim ? { kind: "bar", title: `Margin % by ${dim.name}`, unit: "percent", categories: groups.map((g) => g.key), values: groups.map((g) => g.margin ?? 0), horizontal: true } : undefined;
    return b.done(jsonSafe({ overall: { revenue: r.overall.revenue * rev.scale, profit: r.overall.profit * prof.scale, margin: r.overall.margin }, dimension: dim?.name ?? null, groups, lossMakers: r.lossMakers.slice(0, 10).map((g) => g.key), highRevenueLowMargin: r.highRevenueLowMargin.slice(0, 5).map((g) => g.key) }), {
      summary, method: "Margin = SUM(profit) ÷ SUM(revenue) for the whole set and for each group — never an average of row-level margins.", chart,
    });
  },
};

/* ---------------------------------- correlation ------------------------------ */

const correlation: ToolDef = {
  name: "correlation",
  description: "Do two numeric columns move together? Pearson (and Spearman) correlation with sample size and significance. Relationships that hold by construction (e.g. profit = revenue − cost, revenue = quantity × price) are reported as arithmetic, not as findings. Omit both columns to scan for the strongest genuine relationships.",
  parameters: { properties: { column_a: { type: "string" }, column_b: { type: "string" }, top_k: { type: "integer", minimum: 1, maximum: 10, default: 5 }, ...COMMON_PROPS } },
  gate: (ctx) => (ctx.profile.capabilities.correlation ? null : ctx.profile.capabilities.unavailable.correlation ?? "Correlation needs at least two numeric columns."),
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const b = new Builder("correlation", sc.ctx, { column_a: p.column_a ?? null, column_b: p.column_b ?? null, top_k: p.top_k, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const rel = sc.ctx.profile.relations;
    const describe = (a: string, bb: string, r: number, sp: number | null, n: number, pv: number) => {
      const rf = b.fs.num(`Pearson r (${a}, ${bb})`, r, "number", { decimals: 2, signed: true }), nf = b.fs.num("Paired observations", n, "count"), pf = b.fs.num("p-value", pv, "number", { decimals: 3 });
      const sf = sp !== null ? b.fs.num(`Spearman ρ (${a}, ${bb})`, sp, "number", { decimals: 2, signed: true }) : null;
      return { rf, nf, pf, sf };
    };
    if (p.column_a && p.column_b) {
      const A = resolveMeasure(sc.ctx, p.column_a as string), B = resolveMeasure(sc.ctx, p.column_b as string);
      if (A.name === B.name) throw new AnalyticsError("invalid_argument", "Choose two different columns.");
      const c = correlate(sc.ctx.frame, sc.ctx.rows, A.name, B.name, rel);
      const structural = structuralCorrelationReason(sc.ctx, A.name, B.name);
      const d = describe(A.name, B.name, c.r, c.spearman, c.n, c.p);
      const reason = c.reason ?? structural;
      const summary = reason
        ? `${A.name} and ${B.name} are related by construction, so their correlation (r = ${d.rf.display}, n = ${d.nf.display}) is not a meaningful finding: ${reason}`
        : `${A.name} and ${B.name} have a ${strength(c.r)} ${c.r > 0 ? "positive" : "negative"} correlation (r = ${d.rf.display}${d.sf ? `, Spearman ρ = ${d.sf.display}` : ""}, n = ${d.nf.display}, p = ${d.pf.display}). Correlation is not causation.`;
      return b.done(jsonSafe({ a: A.name, b: B.name, r: c.r, spearman: c.spearman, n: c.n, p: c.p, tautological: !!reason, reason: reason ?? null }), { summary, method: "Pearson correlation on paired non-blank values, with a Spearman rank check; arithmetic identities are excluded from findings.", chart: reason ? undefined : scatterOf(sc.ctx, A.name, B.name, c.r) });
    }
    const cols = sc.ctx.profile.capabilities.measures.slice(0, 12);
    const pairs = correlationPairs(sc.ctx.frame, sc.ctx.rows, cols, { relations: rel });
    const k = clampInt(p.top_k, 1, 10, 5);
    const genuine = pairs.filter((x) => !x.tautological && !structuralCorrelationReason(sc.ctx, x.a, x.b));
    const top = genuine.slice(0, k).map((x) => {
      const d = describe(x.a, x.b, x.r, x.spearman, x.n, x.p);
      return { a: x.a, b: x.b, r: x.r, rDisplay: d.rf.display, strength: strength(x.r), n: x.n, p: x.p };
    });
    const skipped = pairs.length - genuine.length;
    if (skipped) b.caveat(`${b.fs.num("Pairs excluded as arithmetic", skipped, "count").display} pairs were excluded because they are related by construction (for example profit = revenue − cost).`);
    const summary = top.length ? `Strongest genuine relationships: ${top.map((t) => `${t.a} & ${t.b} (r = ${t.rDisplay}, ${t.strength})`).join("; ")}.` : "No genuine relationship between numeric columns stands out.";
    const lead = top[0];
    const chart = lead ? scatterOf(sc.ctx, lead.a, lead.b, lead.r) : undefined;
    return b.done(jsonSafe({ pairs: top }), { summary, method: "All pairwise Pearson correlations on a sample of up to 50,000 rows; tautological and structural pairs removed.", chart });
  },
};

/* ----------------------------------- outliers -------------------------------- */

/** Deterministic stride sample of paired non-blank values, so a scatter never ships 50k points. */
function scatterOf(ctx: AnalysisContext, a: string, b: string, r: number, max = 400): ChartSpec | undefined {
  const ca = ctx.frame.get(a), cb = ctx.frame.get(b);
  if (!ca || !cb || ca.kind !== "number" || cb.kind !== "number") return undefined;
  const sa = metricSpec(ctx, a), sb = metricSpec(ctx, b);
  const idx: number[] = [];
  const n = ctx.rows ? ctx.rows.length : ctx.frame.rowCount;
  for (let i = 0; i < n; i++) {
    const row = ctx.rows ? ctx.rows[i]! : i;
    if (!Number.isNaN(ca.values[row]!) && !Number.isNaN(cb.values[row]!)) idx.push(row);
  }
  if (idx.length < 3) return undefined;
  const step = Math.max(1, Math.ceil(idx.length / max));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < idx.length; i += step) pts.push({ x: ca.values[idx[i]!]! * sa.scale, y: cb.values[idx[i]!]! * sb.scale });
  void r;
  return { kind: "scatter", title: `${b} vs ${a}`, unit: sb.unit, currency: ctx.fmt.currency, xUnit: sa.unit, xLabel: a, yLabel: b, points: pts, note: step > 1 ? "A sample of the points is drawn; statistics use every row." : undefined };
}

const outliers: ToolDef = {
  name: "outliers",
  description: "How many values of a numeric column are unusually high or low (IQR fences, z-score or MAD), with the thresholds used. Individual rows are only shown when the workspace allows row-level examples.",
  parameters: { properties: { column: { type: "string" }, method: { type: "string", enum: ["iqr", "zscore", "mad"], default: "iqr" }, ...COMMON_PROPS }, required: ["column"] },
  gate: (ctx) => (ctx.profile.capabilities.outliers ? null : ctx.profile.capabilities.unavailable.outliers ?? null),
  run(ctx, p, policy) {
    const sc = scopeFor(ctx, p);
    const col = resolveMeasure(sc.ctx, p.column as string);
    const spec = metricSpec(sc.ctx, col.name);
    const b = new Builder("outliers", sc.ctx, { column: col.name, method: p.method ?? "iqr", filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const r = detectOutliers(sc.ctx.frame, sc.ctx.rows, col.name, { method: (p.method as "iqr" | "zscore" | "mad") ?? "iqr", examples: policy.exposeRows ? 10 : 0 });
    const cnt = b.fs.num("Outlier values", r.count, "count"), pct = b.fs.num("Share of values", r.pctOfRows, "percent"), hi = b.fs.num("High outliers", r.countHigh, "count"), lo = b.fs.num("Low outliers", r.countLow, "count");
    const low = b.fs.num("Lower threshold", r.thresholds.low * spec.scale, spec.unit), high = b.fs.num("Upper threshold", r.thresholds.high * spec.scale, spec.unit);
    if (!policy.exposeRows) b.caveat("Individual rows are not shown; only counts and thresholds.");
    return b.done(jsonSafe({ column: col.name, method: r.method, count: r.count, high: r.countHigh, low: r.countLow, pct: r.pctOfRows, thresholds: { low: r.thresholds.low * spec.scale, high: r.thresholds.high * spec.scale, description: r.thresholds.description }, examples: policy.exposeRows ? r.examples : undefined }), {
      summary: `${cnt.display} of ${col.name}'s values (${pct.display}) fall outside the fences (${r.thresholds.description}): ${hi.display} above ${high.display} and ${lo.display} below ${low.display}.`,
      method: r.thresholds.description,
    });
  },
};

/* ------------------------------------ customers ------------------------------ */

const customerTool: ToolDef = {
  name: "customer_analysis",
  description: "Customer (or other entity) behaviour: how many distinct customers, the repeat rate, how concentrated value is (top 10% of customers), the top customers by a metric, and new vs returning customers over time.",
  parameters: { properties: { customer: { type: "string", description: "Customer/entity column (default: the detected customer column)" }, metric: { type: "string", description: "Numeric metric for value (default: lead metric)" }, top_n: { type: "integer", minimum: 1, maximum: 25, default: 5 }, ...COMMON_PROPS } },
  gate: (ctx) => (ctx.profile.capabilities.customer ? null : ctx.profile.capabilities.unavailable.customers ?? "No customer column was identified."),
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const cust = resolveColumn(sc.ctx, (p.customer as string) ?? sc.ctx.profile.capabilities.customer!, { kind: "any" });
    const m = pickMetric(sc.ctx, { metric: p.metric, agg: "sum" });
    const metric = m.column && m.column.physical === "number" && m.additive ? m.column.name : undefined;
    const caps = sc.ctx.profile.capabilities;
    const top = clampInt(p.top_n, 1, 25, 5);
    const b = new Builder("customer_analysis", sc.ctx, { customer: cust.name, metric: metric ?? null, top_n: top, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    let bundle;
    try { if (caps.timeSeries) bundle = seriesFor(sc.ctx, {}); } catch { bundle = undefined; }
    const pts = bundle?.complete.points;
    const r = customerAnalysis(sc.ctx.frame, sc.ctx.rows, { customer: cust.name, metric, dateColumn: caps.eventDate ?? undefined, grain: bundle?.grain, topN: top, minOrd: pts?.[0]?.ord, maxOrd: pts?.[pts.length - 1]?.ord });
    const d = b.fs.num(`Distinct ${cust.name}`, r.distinct, "count"), rep = b.fs.num("Repeat rate", r.repeat.ratePct, "percent"), avg = b.fs.num(`Rows per ${cust.name}`, r.repeat.avgRowsPerCustomer, "number", { decimals: 1 });
    let summary = `${d.display} distinct ${cust.name} values; ${rep.display} appear in more than one row (${avg.display} rows each on average).`;
    const topRows = r.value.top.map((g, i) => {
      const sp = metric ? metricSpec(sc.ctx, metric) : null;
      const vf = b.fs.num(`${g.key}: ${metric ?? "rows"}`, g.value * (sp?.scale ?? 1), sp?.unit ?? "count");
      const sh = g.share !== null ? b.fs.num(`${g.key}: share`, g.share, "percent") : null;
      return { rank: i + 1, key: g.key, value: g.value * (sp?.scale ?? 1), display: vf.display, share: sh?.value ?? null, shareDisplay: sh?.display ?? null };
    });
    if (metric && r.value.topDecileShare !== null) {
      const td = b.fs.num(`Share of ${metric} from the top 10% of ${cust.name}`, r.value.topDecileShare, "percent"), tc = b.fs.num("Customers in the top 10%", r.value.topDecileCount, "count");
      summary += ` The top decile (${tc.display} customers) generate ${td.display} of ${metric}.`;
    }
    if (topRows.length) summary += `\nTop ${cust.name} values by ${metric ?? "rows"}:\n${topRows.map((t) => `${t.rank}. ${t.key} — ${t.display}${t.shareDisplay ? ` (${t.shareDisplay})` : ""}`).join("\n")}`;
    if (r.rowsWithoutCustomer) b.caveat(`${b.fs.num("Rows without a customer", r.rowsWithoutCustomer, "count").display} rows have no ${cust.name} and are ignored.`);
    return b.done(jsonSafe({ customer: cust.name, metric: metric ?? null, distinct: r.distinct, repeatRatePct: r.repeat.ratePct, avgRowsPerCustomer: r.repeat.avgRowsPerCustomer, topDecileSharePct: r.value.topDecileShare, top: topRows, newVsReturning: r.newVsReturning?.points.slice(-24) }), {
      summary, method: "Rows are grouped by customer; repeat rate = customers with more than one row ÷ all customers; new = first appearance in the period.",
    });
  },
};

const cohortTool: ToolDef = {
  name: "cohort_retention",
  description: "Retention by cohort: customers grouped by the period of their first activity, and the share still active 1, 2, 3… periods later. Uses complete periods only.",
  parameters: { properties: { customer: { type: "string" }, grain: { type: "string", enum: ["week", "month", "quarter"] }, max_cohorts: { type: "integer", minimum: 2, maximum: 12, default: 8 }, max_offset: { type: "integer", minimum: 1, maximum: 12, default: 6 }, ...COMMON_PROPS } },
  gate: (ctx) => (ctx.profile.capabilities.cohort ? null : ctx.profile.capabilities.unavailable.cohort ?? "Cohort analysis isn't available."),
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const caps = sc.ctx.profile.capabilities;
    const cust = resolveColumn(sc.ctx, (p.customer as string) ?? caps.customer!, { kind: "any" });
    const bundle = seriesFor(sc.ctx, { grain: p.grain as Grain | undefined });
    const pts = bundle.complete.points;
    const b = new Builder("cohort_retention", sc.ctx, { customer: cust.name, grain: bundle.grain, max_cohorts: p.max_cohorts, max_offset: p.max_offset, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    for (const n of bundle.complete.notes) b.caveat(n);
    if (pts.length < 3) throw new AnalyticsError("insufficient_data", "Cohort analysis needs at least three complete periods.");
    const r = cohortAnalysis(sc.ctx.frame, sc.ctx.rows, { customer: cust.name, dateColumn: caps.eventDate!, grain: bundle.grain, minOrd: pts[0]!.ord, maxOrd: pts[pts.length - 1]!.ord, maxCohorts: clampInt(p.max_cohorts, 2, 12, 8), maxOffset: clampInt(p.max_offset, 1, 12, 6) });
    const rows = r.cohorts.map((c) => {
      const sz = b.fs.num(`${c.cohort}: cohort size`, c.size, "count");
      const cells = c.retainedPct.map((v, i) => (v === null || i === 0 ? v : (b.fs.num(`${c.cohort}: retained after ${i} ${bundle.grain}s`, v, "percent"), v)));
      return { cohort: c.cohort, size: c.size, sizeDisplay: sz.display, retainedPct: cells };
    });
    // average retention by offset (weighted by cohort size)
    const avg: (number | null)[] = [];
    for (let off = 1; off <= r.maxOffset; off++) {
      let num = 0, den = 0;
      for (const c of r.cohorts) { const v = c.retention[off]; if (v !== null && v !== undefined) { num += v; den += c.size; } }
      const val = den ? (num / den) * 100 : null;
      avg.push(val);
      if (val !== null) b.fs.num(`Average retention after ${off} ${bundle.grain}s`, val, "percent");
    }
    const a1 = avg[0];
    const chart: ChartSpec = { kind: "heatmap", title: `Cohort retention (% of customers active), by ${bundle.grain}`, unit: "percent", rows: r.cohorts.map((c) => c.cohort), columns: Array.from({ length: r.maxOffset + 1 }, (_, i) => `+${i}`), values: r.cohorts.map((c) => c.retainedPct) };
    return b.done(jsonSafe({ customer: cust.name, grain: bundle.grain, cohorts: rows, averageRetentionPct: avg }), {
      summary: a1 !== null && a1 !== undefined ? `Across ${b.fs.num("Cohorts shown", r.cohorts.length, "count").display} cohorts, ${b.fs.num("Average retention after 1 period", a1, "percent").display} of customers are active one ${bundle.grain} after their first activity.` : `Cohort table built for ${r.cohorts.length} cohorts.`,
      method: "A customer's cohort is the period of their first activity in the data; retention is the share of the cohort with any activity k periods later.", chart,
    });
  },
};

const funnelTool: ToolDef = {
  name: "funnel",
  description: "Funnel conversion across ordered stages (lead → qualified → won, visit → cart → purchase): count at each stage, conversion from the previous and the first stage, and the biggest drop-off. Stage order is inferred for common funnels or must be provided.",
  parameters: { properties: { stage_column: { type: "string" }, stage_order: { type: "array", items: { type: "string" }, description: "Stages from first to last" }, entity_column: { type: "string", description: "Column identifying the entity moving through stages (optional)" }, ...COMMON_PROPS } },
  gate: (ctx) => (ctx.profile.capabilities.stage ? null : ctx.profile.capabilities.unavailable.funnel ?? "No stage column was identified."),
  run(ctx, p) {
    const sc = scopeFor(ctx, p);
    const stage = resolveColumn(sc.ctx, (p.stage_column as string) ?? sc.ctx.profile.capabilities.stage!, { kind: "string" });
    const ent = p.entity_column ? resolveColumn(sc.ctx, p.entity_column as string, { kind: "any" }) : null;
    const b = new Builder("funnel", sc.ctx, { stage_column: stage.name, stage_order: p.stage_order ?? null, entity_column: ent?.name ?? null, filters: p.filters, date_from: p.date_from, date_to: p.date_to }, sc.warnings);
    const r = funnelAnalysis(sc.ctx.frame, sc.ctx.rows, { stageColumn: stage.name, stageOrder: p.stage_order as string[] | undefined, entityColumn: ent?.name });
    const stages = r.stages.map((s) => {
      const c = b.fs.num(`${s.stage}: reached`, s.reached, "count");
      const fp = s.conversionFromPrevious !== null ? b.fs.num(`${s.stage}: conversion from previous stage`, s.conversionFromPrevious, "percent") : null;
      const ff = b.fs.num(`${s.stage}: conversion from first stage`, s.conversionFromFirst, "percent");
      return { stage: s.stage, reached: s.reached, reachedDisplay: c.display, fromPrevious: s.conversionFromPrevious, fromPreviousDisplay: fp?.display ?? null, fromFirst: s.conversionFromFirst, fromFirstDisplay: ff.display };
    });
    let summary = `Funnel (${r.orderSource === "inferred" ? "stage order inferred" : "stage order provided"}, ${r.mode} counting):\n${stages.map((s, i) => `${i + 1}. ${s.stage} — ${s.reachedDisplay}${s.fromPreviousDisplay ? ` (${s.fromPreviousDisplay} of the previous stage)` : ""}`).join("\n")}`;
    if (r.biggestDropOff) { const l = b.fs.num("Biggest drop-off", r.biggestDropOff.lostPct, "percent"); summary += `\nThe biggest drop-off is from ${r.biggestDropOff.from} to ${r.biggestDropOff.to}, losing ${l.display}.`; }
    if (r.orderSource === "inferred") b.caveat("The stage order was inferred from the stage names; confirm it or provide stage_order.");
    const chart: ChartSpec = { kind: "funnel", title: `Funnel by ${stage.name}`, unit: "count", stages: r.stages.map((s) => ({ label: s.stage, value: s.reached, pctOfFirst: s.conversionFromFirst ?? 0, pctOfPrevious: s.conversionFromPrevious })) };
    return b.done(jsonSafe({ stageColumn: stage.name, mode: r.mode, orderSource: r.orderSource, stages, biggestDropOff: r.biggestDropOff }), { summary, method: "Counts entities that reached each stage; in snapshot data an entity at a later stage counts as having reached earlier ones.", chart });
  },
};

/* ------------------------------------ quality -------------------------------- */

const dataQuality: ToolDef = {
  name: "data_quality",
  description: "The data-quality report: overall score and every issue found (missing values, duplicates, outliers, inconsistent labels, unreadable values, ambiguous dates), with what was done about each.",
  parameters: { properties: {} },
  run(ctx) {
    const q = ctx.profile.quality;
    const b = new Builder("data_quality", ctx, {});
    const sc = b.fs.num("Data quality score", q.score, "count"), comp = b.fs.num("Completeness", q.completeness, "percent");
    const issues = q.issues.slice(0, 15).map((i) => { const a = b.fs.num(`Issue affects (${i.kind}${i.column ? `: ${i.column}` : ""})`, i.affected, "count"); return { severity: i.severity, kind: i.kind, column: i.column ?? null, affected: i.affected, affectedDisplay: a.display, detail: i.detail, fix: i.fix }; });
    const high = b.fs.num("High-severity issues", q.counts.high, "count"), med = b.fs.num("Medium-severity issues", q.counts.medium, "count"), low = b.fs.num("Low-severity issues", q.counts.low, "count");
    return b.done(jsonSafe({ score: q.score, label: q.label, completeness: q.completeness, counts: q.counts, issues }), {
      summary: `Data quality is ${q.label.toLowerCase()} (score ${sc.display}); ${comp.display} of cells are filled. Issues: ${high.display} high, ${med.display} medium, ${low.display} low.`,
      method: "Score = 100 − missing-value penalty − duplicate penalty − weighted issue severities.",
    });
  },
};

export const ANALYSIS_TOOLS: ToolDef[] = [profitability, correlation, outliers, customerTool, cohortTool, funnelTool, dataQuality];
export type { AnalysisContext };
