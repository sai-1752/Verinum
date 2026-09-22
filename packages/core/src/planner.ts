/**
 * Deterministic question → tool-call planner.
 *
 * This is the no-LLM path of the grounded analyst: it maps common analytical questions onto a tool
 * call using only the dataset's own vocabulary (column names, category values, business meanings)
 * and a small intent lexicon. It is used when no AI provider is configured (demo / self-hosted),
 * when the provider is down or over quota, and as the safe fallback when a model answer fails the
 * grounding check. It never guesses a number — it only chooses which tool to run, and the tool
 * computes the answer.
 */
import type { AnalysisContext } from "./context";
import type { StringColumn } from "./frame";
import { candidateDimensions } from "./insights/generators";
import type { ColumnProfile } from "./types";

export interface PlannedCall {
  tool: string;
  params: Record<string, unknown>;
  /** why this tool was chosen (shown in the UI's "how was this answered" panel) */
  rationale: string;
  confidence: "high" | "medium" | "low";
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const singular = (w: string) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Words that stand for a business meaning, beyond the column's own name. */
const MEANING_WORDS: Record<string, string[]> = {
  revenue: ["revenue", "sales", "turnover", "income"], profit: ["profit", "earnings"], cost: ["cost", "costs", "expenses", "cogs"],
  quantity: ["quantity", "units", "volume", "qty"], marketing: ["marketing", "ad spend", "advertising"], discount: ["discount", "discounts"], price: ["price", "prices"],
  customer: ["customer", "customers", "client", "clients", "buyer", "buyers"], product: ["product", "products", "item", "items", "sku", "skus"],
  region: ["region", "regions", "country", "countries", "geography", "market", "markets", "territory"], channel: ["channel", "channels"], segment: ["segment", "segments"],
  stage: ["stage", "stages", "status"],
};

function phrases(c: ColumnProfile): string[] {
  const base = norm(c.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "));
  const out = new Set<string>([base, singular(base), `${base}s`, base.replace(/ /g, "")]);
  if (c.meaning) for (const w of MEANING_WORDS[c.meaning] ?? []) out.add(w);
  return [...out].filter((x) => x.length >= 3);
}

function mentions(q: string, phrase: string): number {
  const re = new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  const m = re.exec(q);
  return m ? m.index : -1;
}

interface Found { col: ColumnProfile; at: number }

function findColumns(ctx: AnalysisContext, q: string, pred: (c: ColumnProfile) => boolean): Found[] {
  const out: Found[] = [];
  for (const c of ctx.profile.columns) {
    if (!pred(c)) continue;
    let best = -1;
    for (const p of phrases(c)) {
      const at = mentions(q, p);
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    if (best >= 0) out.push({ col: c, at: best });
  }
  // an exact column-name hit beats a meaning alias hit on another column ("sales" → Sales, not Revenue too)
  return out.sort((a, b) => a.at - b.at);
}

/** Category values (e.g. "North America") named in the question, with the column they belong to. */
function findValues(ctx: AnalysisContext, qRaw: string): { column: string; value: string }[] {
  const q = ` ${norm(qRaw)} `;
  const out: { column: string; value: string; len: number }[] = [];
  for (const c of ctx.profile.columns) {
    if (!c.chartDimension && c.meaning !== "product") continue;
    const col = ctx.frame.get(c.name);
    if (!col || col.kind !== "string") continue;
    for (const v of (col as StringColumn).dict) {
      if (!v) continue;
      const nv = norm(v);
      if (nv.length < 2) continue;
      if (q.includes(` ${nv} `)) out.push({ column: c.name, value: v, len: nv.length });
    }
  }
  // longest match first; drop values fully contained in a longer match
  out.sort((a, b) => b.len - a.len);
  const kept: typeof out = [];
  for (const o of out) if (!kept.some((k) => norm(k.value).includes(norm(o.value)) && k.value !== o.value)) kept.push(o);
  return kept.map(({ column, value }) => ({ column, value }));
}

interface DateHint { from?: string; to?: string; key?: string }

function periodsIn(ctx: AnalysisContext, q: string): string[] {
  const keys: string[] = [];
  for (const m of q.matchAll(/\b(\d{4})-(\d{2})\b/g)) keys.push(`${m[1]}-${m[2]}`);
  for (const m of q.matchAll(/\bq([1-4])\s*(?:of\s*)?(\d{4})\b/gi)) keys.push(`${m[2]}-Q${m[1]}`);
  for (const m of q.matchAll(/\b(\d{4})\s*q([1-4])\b/gi)) keys.push(`${m[1]}-Q${m[2]}`);
  for (const m of q.matchAll(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{4})\\b`, "gi"))) keys.push(`${m[2]}-${String(MONTHS.indexOf(m[1]!.toLowerCase()) + 1).padStart(2, "0")}`);
  if (!keys.length) for (const m of q.matchAll(/\b(19|20)\d{2}\b/g)) keys.push(m[0]);
  const cal = ctx.profile.calendar;
  if (/\b(last|previous) month\b/.test(q) && cal?.lastCompleteKey && cal.grain === "month") keys.push(cal.lastCompleteKey);
  return [...new Set(keys)];
}

function dateHint(ctx: AnalysisContext, q: string): DateHint {
  const keys = periodsIn(ctx, q);
  if (keys.length === 1) return { from: keys[0], to: keys[0], key: keys[0] };
  if (keys.length >= 2 && /\b(between|from)\b/.test(q)) { const s = [...keys].sort(); return { from: s[0], to: s[s.length - 1] }; }
  return {};
}

const has = (q: string, re: RegExp) => re.test(q);
const num = (q: string): number | null => {
  const m = /\b(?:top|bottom|first|last|best|worst)\s+(\d{1,3})\b/.exec(q) ?? /\b(\d{1,3})\s+(?:best|worst|top|bottom|highest|lowest|largest|smallest)\b/.exec(q);
  if (m) return Number(m[1]);
  const words: Record<string, number> = { three: 3, five: 5, ten: 10, two: 2, four: 4, six: 6, seven: 7, eight: 8, nine: 9 };
  const w = /\b(?:top|bottom)\s+(two|three|four|five|six|seven|eight|nine|ten)\b/.exec(q);
  return w ? words[w[1]!]! : null;
};

export function planQuestion(ctx: AnalysisContext, question: string): PlannedCall | null {
  const q = norm(question);
  if (!q) return null;
  const caps = ctx.profile.capabilities;
  const cols = ctx.profile.columns;

  const measures = findColumns(ctx, q, (c) => c.type === "numeric" && c.role === "measure");
  const dims = findColumns(ctx, q, (c) => (c.groupable || c.chartDimension) && c.role !== "text" && c.type !== "numeric" && c.role !== "time");
  const values = findValues(ctx, question);
  const dh = dateHint(ctx, question);
  const dateParams: Record<string, unknown> = { ...(dh.from ? { date_from: dh.from } : {}), ...(dh.to ? { date_to: dh.to } : {}) };
  const metric = measures[0]?.col.name;
  const metricP: Record<string, unknown> = metric ? { metric } : {};
  const filtersFromValues = (exceptColumn?: string) => values.filter((v) => v.column !== exceptColumn).slice(0, 3).map((v) => ({ column: v.column, op: "eq", value: v.value }));
  const withFilters = (p: Record<string, unknown>, except?: string, noDate = false): Record<string, unknown> => {
    const f = filtersFromValues(except);
    return { ...p, ...(noDate ? {} : dateParams), ...(f.length ? { filters: f } : {}) };
  };
  const dim = dims[0]?.col.name;
  const wantsAsc = has(q, /\b(bottom|worst|lowest|least|smallest|fewest|weakest|poorest)\b/);
  const n = num(q);

  // 1. data quality / overview
  if (has(q, /\b(data quality|missing|blank|duplicates?|dirty|clean(ing)?|quality)\b/)) return { tool: "data_quality", params: {}, rationale: "The question is about data quality.", confidence: "high" };
  if (has(q, /\b(what is (this|the) (data|dataset)|describe (the |this )?(data|dataset)|columns|schema|overview|what data|about (this|the) data)\b/)) return { tool: "describe_dataset", params: {}, rationale: "The question asks what the dataset contains.", confidence: "high" };

  // 2. forecast
  if (has(q, /\b(forecast|predict|projection|project|outlook|next (month|quarter|year|week|period))\b/)) {
    return { tool: "forecast", params: withFilters({ ...metricP }), rationale: "The question asks about the future, which needs a forecast.", confidence: "high" };
  }

  // 3. why did it change
  if (has(q, /\b(why|what (drove|caused|explains?)|reason for|driver|drivers|behind)\b/) && has(q, /\b(drop|dropped|fall|fell|decline|declined|decrease|down|rise|rose|increase|increased|up|change|changed|growth|shrink|shrank|dip)\b/)) {
    const keys = periodsIn(ctx, question);
    const p: Record<string, unknown> = { ...metricP };
    if (keys.length >= 2) { p.period_a = keys[keys.length - 1]; p.period_b = keys[0]; } else if (keys.length === 1) p.period_a = keys[0];
    if (has(q, /\byear (over|on) year|yoy|year ago\b/)) p.compare_to = "year_ago";
    return { tool: "explain_change", params: withFilters(p, undefined, true), rationale: "The question asks what drove a change between periods.", confidence: "high" };
  }
  if (has(q, /\bvolume\b.*\bmargin\b|\bmargin\b.*\bvolume\b|\bprice\b.*\bvolume\b/) && caps.margin) return { tool: "volume_vs_margin", params: withFilters({}), rationale: "The question splits a profit change into volume and margin.", confidence: "medium" };

  // 4. compare
  if (has(q, /\b(compare|versus|vs|difference between|against|than)\b/)) {
    if (values.length >= 2 && values[0]!.column === values[1]!.column) {
      return { tool: "compare_groups", params: { dimension: values[0]!.column, group_a: values[0]!.value, group_b: values[1]!.value, ...metricP, ...dateParams }, rationale: `Compares two ${values[0]!.column} values.`, confidence: "high" };
    }
    const keys = periodsIn(ctx, question);
    if (keys.length >= 2) {
      const fromTo = /\bfrom\b.*\bto\b/.test(q);
      const [a, b] = fromTo ? [keys[1]!, keys[0]!] : [keys[0]!, keys[1]!];
      return { tool: "compare_periods", params: withFilters({ ...metricP, period_a: a, period_b: b, ...(dim ? { breakdown_dimension: dim } : {}) }, undefined, true), rationale: "Compares two periods.", confidence: "high" };
    }
    if (has(q, /\b(month|quarter|year|week|period)\b/) && caps.timeSeries) {
      return { tool: "compare_periods", params: withFilters({ ...metricP, ...(dim ? { breakdown_dimension: dim } : {}) }, undefined, true), rationale: "Compares the latest complete period with the one before it.", confidence: "medium" };
    }
  }

  // 5. relationships, anomalies, seasonality
  if (has(q, /\b(correlat\w*|relationship|related|depend\w*|associated|linked)\b/) && caps.correlation) {
    const [a, b] = measures;
    return { tool: "correlation", params: withFilters(a && b ? { column_a: a.col.name, column_b: b.col.name } : {}), rationale: "The question asks whether measures move together.", confidence: a && b ? "high" : "medium" };
  }
  if (has(q, /\boutliers?\b/) && caps.outliers) {
    return { tool: "outliers", params: withFilters({ column: metric ?? caps.leadMetric ?? caps.measures[0] }), rationale: "The question asks about unusually high or low values.", confidence: "high" };
  }
  if (has(q, /\b(anomal\w*|unusual|spike|spikes|abnormal|strange|odd)\b/) && caps.timeSeries) {
    return { tool: "anomalies", params: withFilters({ ...metricP }), rationale: "The question asks about unusual periods.", confidence: "high" };
  }
  if (has(q, /\b(seasonal\w*|seasonality|peak season|time of year)\b/)) return { tool: "seasonality", params: withFilters({ ...metricP }), rationale: "The question asks about seasonality.", confidence: "high" };

  // 6. profitability
  if (has(q, /\b(margin|margins|profitab\w*|unprofitable|loss making|loss makers|losing money)\b/) && !has(q, /\bover time|trend|monthly\b/)) {
    if (caps.margin) return { tool: "profitability", params: withFilters(dim ? { dimension: dim } : {}, dim), rationale: "The question is about profitability.", confidence: "high" };
  }
  if (has(q, /\bmargin\b/) && has(q, /\b(trend|over time|monthly|by month|history)\b/) && caps.margin) {
    return { tool: "time_series", params: withFilters({ metric: "margin" }), rationale: "The question asks how the margin moved over time.", confidence: "high" };
  }

  // 7. customers
  if (has(q, /\b(cohort|retention|retained|churn)\b/)) return { tool: "cohort_retention", params: withFilters({}), rationale: "The question is about customer retention.", confidence: "high" };
  if (caps.customer && has(q, /\b(repeat|loyal|returning|top decile|customer base)\b/)) return { tool: "customer_analysis", params: withFilters({ ...metricP }), rationale: "The question is about customer behaviour.", confidence: "medium" };
  if (caps.customer && has(q, /\bhow many (unique |distinct |different )?(customers|clients)\b/)) return { tool: "aggregate", params: withFilters({ metric: caps.customer, agg: "distinct_count" }), rationale: "Counts distinct customers.", confidence: "high" };

  // 8. rankings
  if (has(q, /\b(top|bottom|best|worst|highest|lowest|leading|largest|biggest|smallest|most|least|rank\w*)\b/)) {
    const d = dim ?? (has(q, /\b(selling|sold|sellers?)\b/) ? caps.product : null) ?? caps.product ?? candidateDimensions(ctx, 1)[0]?.name;
    if (d) {
      const nn = n ?? (has(q, /\b(best|worst|highest|lowest|largest|biggest|smallest|leading|most|least)\b/) && !has(q, /\btop|bottom\b/) ? 1 : 5);
      const p: Record<string, unknown> = { dimension: d, ...metricP, n: Math.max(1, Math.min(50, nn)) };
      if (wantsAsc) p.order = "asc";
      if (has(q, /\baverage|avg|mean\b/)) p.agg = "avg";
      if (has(q, /\b(number of orders|order count|most orders|by count|how often|frequency)\b/)) { p.agg = "count"; delete p.metric; }
      return { tool: "top_n", params: withFilters(p, d), rationale: `Ranks ${d} values${metric ? ` by ${metric}` : ""}.`, confidence: dim ? "high" : "medium" };
    }
  }

  // 9. shares and concentration
  if (has(q, /\b(pareto|80 20|concentrat\w*|dependent on|depend on)\b/) && dim) return { tool: "pareto", params: withFilters({ dimension: dim, ...metricP }, dim), rationale: "The question is about concentration.", confidence: "high" };
  if (has(q, /\b(share|proportion|percent(age)? of|what % of|what percent|contribution|contribute)\b/)) {
    const v = values[0];
    if (v) return { tool: "share_of_total", params: { dimension: v.column, value: v.value, ...metricP, ...dateParams }, rationale: `The share held by ${v.value}.`, confidence: "high" };
    if (dim) return { tool: "group_by", params: withFilters({ dimension: dim, ...metricP }, dim), rationale: "Shares of each group.", confidence: "medium" };
  }
  if (has(q, /\b(distribution|histogram|spread|range of)\b/)) return { tool: "distribution", params: withFilters({ column: metric ?? caps.leadMetric }), rationale: "The question asks how values are spread.", confidence: "medium" };

  // 10. trends over time
  if (has(q, /\b(trend|trending|over time|monthly|weekly|daily|quarterly|yearly|by (day|week|month|quarter|year)|per (day|week|month|quarter|year)|growth|growing|history|evolve\w*|evolution|month over month|year over year)\b/) && caps.timeSeries) {
    const grain = has(q, /\b(daily|by day|per day)\b/) ? "day" : has(q, /\b(weekly|by week|per week)\b/) ? "week" : has(q, /\b(quarterly|by quarter|per quarter)\b/) ? "quarter" : has(q, /\b(yearly|by year|per year|annual\w*)\b/) ? "year" : has(q, /\b(monthly|by month|per month)\b/) ? "month" : undefined;
    const tool = has(q, /\b(trend|trending|growing|growth)\b/) && !has(q, /\b(by|per) (day|week|month|quarter|year)\b/) ? "trend" : "time_series";
    return { tool, params: withFilters({ ...metricP, ...(grain ? { grain } : {}) }), rationale: "The question is about change over time.", confidence: "high" };
  }

  // 11. breakdowns
  if (dim && has(q, /\b(by|per|across|for each|each|breakdown|broken down|split)\b/)) {
    return { tool: "group_by", params: withFilters({ dimension: dim, ...metricP }, dim), rationale: `Breaks the metric down by ${dim}.`, confidence: "high" };
  }

  // 12. totals
  if (has(q, /\b(total|sum|how much|how many|average|avg|mean|median|count|number of|overall|altogether|in total)\b/) || measures.length) {
    let agg: string | undefined;
    if (has(q, /\b(average|avg|mean)\b/)) agg = "avg";
    else if (has(q, /\bmedian\b/)) agg = "median";
    else if (has(q, /\b(how many|count|number of)\b/) && !measures.length) agg = "count";
    else if (has(q, /\b(maximum|max|largest single)\b/)) agg = "max";
    else if (has(q, /\b(minimum|min|smallest single)\b/)) agg = "min";
    const p: Record<string, unknown> = { ...metricP };
    if (agg) p.agg = agg;
    if (agg === "count") delete p.metric;
    return { tool: "aggregate", params: withFilters(p), rationale: "A single overall figure.", confidence: measures.length ? "high" : "medium" };
  }

  if (dim) return { tool: "group_by", params: withFilters({ dimension: dim, ...metricP }, dim), rationale: "Breaks the metric down by the category mentioned.", confidence: "low" };
  void cols;
  return null;
}

/** Follow-up questions that the planner can itself answer, chosen from what was just asked. */
export function suggestFollowUps(ctx: AnalysisContext, lastTool?: string): string[] {
  const caps = ctx.profile.capabilities;
  const lead = caps.leadMetric ? caps.leadMetric.toLowerCase() : "records";
  const region = caps.region ?? candidateDimensions(ctx, 1)[0]?.name;
  const out: string[] = [];
  const add = (s: string | null | undefined) => { if (s && !out.includes(s)) out.push(s); };
  if (lastTool === "top_n" || lastTool === "group_by") { add(caps.timeSeries ? `How has ${lead} changed over time?` : null); add(caps.margin && region ? `Which ${region.toLowerCase()} has the best margin?` : null); }
  if (lastTool === "time_series" || lastTool === "trend") { add(caps.forecast ? `What is the forecast for ${lead}?` : null); add(caps.timeSeries ? `Were there any unusual periods in ${lead}?` : null); add(`Why did ${lead} change in the latest month?`); }
  if (lastTool === "explain_change" || lastTool === "compare_periods") { add(caps.margin ? "How did the margin change?" : null); add(caps.product ? `What are the top 5 ${caps.product.toLowerCase()}s?` : null); }
  if (lastTool === "forecast") { add(caps.seasonality ? `Is there seasonality in ${lead}?` : null); add("How reliable is this forecast?"); }
  if (lastTool === "profitability") { add(caps.timeSeries ? "How has the margin changed over time?" : null); }
  if (!out.length) { add(caps.product ? `What are the top 5 ${caps.product.toLowerCase()}s?` : null); add(caps.timeSeries ? `How has ${lead} changed over time?` : null); add(region ? `Show ${lead} by ${region.toLowerCase()}` : null); }
  return out.slice(0, 3);
}

/** Starter questions for an empty chat: each is answerable by `planQuestion` on this dataset. */
export function starterQuestions(ctx: AnalysisContext): string[] {
  const caps = ctx.profile.capabilities;
  const lead = caps.leadMetric ? caps.leadMetric.toLowerCase() : null;
  const out: string[] = [];
  if (caps.product) out.push(`What are the top 5 ${caps.product.toLowerCase()}s?`);
  if (lead && caps.timeSeries) out.push(`How has ${lead} changed over time?`);
  const d = candidateDimensions(ctx, 3).find((x) => x.meaning !== "product" && x.meaning !== "customer");
  if (lead && d) out.push(`Show ${lead} by ${d.name.toLowerCase()}`);
  if (caps.timeSeries && lead) out.push(`Why did ${lead} change in the latest month?`);
  if (caps.forecast) out.push(`What is the forecast for ${lead ?? "the next period"}?`);
  if (caps.margin) out.push("Which groups have the lowest margin?");
  out.push("How good is the quality of this data?");
  return out.slice(0, 6);
}
