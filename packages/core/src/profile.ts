/**
 * Semantic profiler: physical types → semantic type, role, business meaning and confidence.
 *
 * Evidence used (spec §10, §12): name tokens AND statistics AND arithmetic relations between
 * columns — never the name alone. Every decision records `reasons` so the UI can show why a
 * column was classified as it was.
 */
import { buildTimeSeries } from "./analytics/timeseries";
import { completePeriods } from "./analytics/periods";
import { detectRelations, type Relation } from "./analytics/correlation";
import { duplicateMaskOf, type CleanResult } from "./clean";
import { NULL_BOOL, NULL_CODE, NULL_DATE, type DateColumn, type Frame, type NumberColumn, type StringColumn } from "./frame";
import { histogram, numStats } from "./stats";
import { formatIsoDate, periodKey, periodOrdinal, pickGrain } from "./time";
import { buildCapabilities } from "./capabilities";
import { buildQualityReport } from "./quality";
import {
  ANALYSIS_VERSION,
  type BusinessMeaning, type CalendarInfo, type ColumnProfile, type DatasetProfile,
} from "./types";

/* ------------------------------- name evidence ------------------------------ */

export function nameTokens(name: string): string[] {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

type Weighted = Record<string, number>;
const w = (strong: string, weak = ""): Weighted => {
  const o: Weighted = {};
  for (const s of strong.split(" ").filter(Boolean)) o[s] = 1;
  for (const s of weak.split(" ").filter(Boolean)) o[s] = 0.5;
  return o;
};

const NUMERIC_MEANING_WORDS: Record<string, Weighted> = {
  margin: w("margin margins"),
  profit: w("profit profits ebitda earnings netincome", "contribution net"),
  marketing: w("marketing advertising adspend cac", "campaign media acquisition ad ads"),
  cost: w("cost costs cogs expense expenses opex expenditure", "spend spending"),
  discount: w("discount discounts promo promotion coupon markdown rebate"),
  price: w("price prices asp unitprice listprice", "rate"),
  quantity: w("qty quantity quantities units volume", "unit count pieces items"),
  revenue: w("revenue revenues sales turnover bookings gmv arr mrr linetotal totalprice totalamount netsales grosssales totalsales salesamount", "amount total gross income booking"),
};
const NUMERIC_PRIORITY = ["margin", "profit", "marketing", "cost", "discount", "price", "quantity", "revenue"] as const;

const STRING_MEANING_WORDS: Record<string, Weighted> = {
  customer: w("customer customers client clients buyer buyers member subscriber patient cust", "account user"),
  product: w("product products sku item items goods", "service model title plan"),
  region: w("region country state city territory geo location zone province area", "market store"),
  channel: w("channel platform referrer referral utm medium", "source campaign"),
  segment: w("segment tier category class industry department", "type group"),
  stage: w("stage funnel phase pipeline", "status step"),
};
const STRING_PRIORITY = ["customer", "product", "region", "channel", "stage", "segment"] as const;

const FREE_TEXT_WORDS = new Set(["note", "notes", "comment", "comments", "description", "descriptions", "remark", "remarks", "memo", "feedback", "review", "reviews", "text", "message", "messages", "summary", "detail", "details", "body", "content", "reason"]);
const ID_WORDS = new Set(["id", "uuid", "guid", "key", "code", "no", "num", "number", "ref", "reference", "sku"]);
const NON_ADDITIVE_WORDS = new Set(["share", "pct", "percent", "percentage", "proportion", "ratio", "rate", "score", "index", "avg", "average", "mean", "median", "per", "age", "rating", "temperature", "temp", "latitude", "longitude", "lat", "lon", "lng", "percentile", "nps", "csat", "margin"]);
const CALENDAR_WORDS = new Set(["year", "yr", "month", "quarter", "qtr", "week", "wk", "day", "hour", "weekday", "dow", "fy"]);
const COORD_WORDS = new Set(["latitude", "longitude", "lat", "lon", "lng"]);
const GEO_WORDS = new Set(["country", "state", "city", "province", "region", "zip", "zipcode", "postal", "postcode", "pincode", "territory", "county", "district", "continent"]);
/** Words that say "this is when the business event happened". Generic ones (date, time…) are weaker evidence. */
const EVENT_DATE_SPECIFIC = new Set(["order", "invoice", "transaction", "created", "posted", "closed", "paid", "shipped", "sale", "booking", "event", "purchase", "timestamp"]);
const EVENT_DATE_GENERIC = new Set(["date", "time", "datetime", "period", "day", "month", "week", "year"]);
const ATTR_DATE_WORDS = new Set(["since", "joined", "join", "signup", "registered", "registration", "birth", "birthday", "dob", "hire", "hired", "firstseen", "founded", "expiry", "expires", "expiration", "renewal", "due", "start", "enrolled"]);
const MONEY_MEANINGS = new Set<BusinessMeaning>(["revenue", "cost", "profit", "price", "marketing"]);

const COUNTRIES = new Set("united states,usa,us,uk,united kingdom,india,china,japan,germany,france,italy,spain,canada,australia,brazil,mexico,russia,south korea,korea,netherlands,sweden,norway,denmark,finland,switzerland,austria,belgium,ireland,portugal,poland,turkey,egypt,nigeria,south africa,kenya,argentina,chile,colombia,peru,indonesia,malaysia,singapore,thailand,vietnam,philippines,pakistan,bangladesh,saudi arabia,uae,united arab emirates,israel,new zealand,greece,czech republic,hungary,romania,ukraine".split(","));
const US_STATES = new Set("alabama,alaska,arizona,arkansas,california,colorado,connecticut,delaware,florida,georgia,hawaii,idaho,illinois,indiana,iowa,kansas,kentucky,louisiana,maine,maryland,massachusetts,michigan,minnesota,mississippi,missouri,montana,nebraska,nevada,new hampshire,new jersey,new mexico,new york,north carolina,north dakota,ohio,oklahoma,oregon,pennsylvania,rhode island,south carolina,south dakota,tennessee,texas,utah,vermont,virginia,washington,west virginia,wisconsin,wyoming".split(","));

function scoreWords(tokens: string[], lower: string, dict: Weighted): number {
  let s = 0;
  const tokenSet = new Set(tokens);
  for (const [word, weight] of Object.entries(dict)) {
    if (tokenSet.has(word)) s += weight;
    else if (word.length >= 6 && lower.includes(word)) s += weight * 0.9;
  }
  return s;
}

export interface NameMeaning { meaning: BusinessMeaning; score: number }

export function numericMeaningFromName(name: string): NameMeaning | null {
  const tokens = nameTokens(name);
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: NameMeaning | null = null;
  for (const m of NUMERIC_PRIORITY) {
    const s = scoreWords(tokens, lower, NUMERIC_MEANING_WORDS[m]!);
    if (s > 0 && (!best || s > best.score)) best = { meaning: m, score: s };
  }
  return best;
}

export function stringMeaningFromName(name: string): NameMeaning | null {
  const tokens = nameTokens(name);
  if (tokens.some((t) => FREE_TEXT_WORDS.has(t))) return null; // safeguard 9: a "customer_note" is a caption, not a customer
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: NameMeaning | null = null;
  for (const m of STRING_PRIORITY) {
    const s = scoreWords(tokens, lower, STRING_MEANING_WORDS[m]!);
    if (s > 0 && (!best || s > best.score)) best = { meaning: m, score: s };
  }
  return best;
}

/** Character-shape of a value: "ORD-100001" → "A+-9+" (used to spot code-like identifiers). */
function shapeOf(s: string): string {
  let out = "", last = "";
  for (const ch of s) {
    const c = /[A-Z]/.test(ch) ? "A" : /[a-z]/.test(ch) ? "a" : /[0-9]/.test(ch) ? "9" : ch;
    if (c === last && (c === "A" || c === "a" || c === "9")) continue;
    out += c === "A" || c === "a" || c === "9" ? c + "+" : c;
    last = c;
  }
  return out;
}

/* ------------------------------ column profiling ---------------------------- */

interface Ctx { n: number }

function baseProfile(name: string, index: number, physical: ColumnProfile["physical"], n: number, present: number, distinct: number): ColumnProfile {
  return {
    name, index, physical, type: "categorical", role: "dimension", meaning: null, subtypes: [],
    confidence: 0.9, meaningConfidence: 0, reasons: [],
    count: present, missing: n - present, missingPct: n ? ((n - present) / n) * 100 : 0,
    distinct, distinctPct: present ? (distinct / present) * 100 : 0,
    chartDimension: false, groupable: false, analyzable: true,
  };
}

function profileNumber(col: NumberColumn, index: number, ctx: Ctx): ColumnProfile {
  const vals = col.values;
  const seen = new Set<number>();
  let present = 0, allInt = true;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]!;
    if (v !== v) continue;
    present++;
    if (seen.size <= 200_000) seen.add(v);
    if (allInt && !Number.isInteger(v)) allInt = false;
  }
  const p = baseProfile(col.name, index, "number", ctx.n, present, seen.size);
  if (!present) {
    p.type = "categorical"; p.role = "dimension"; p.analyzable = false; p.confidence = 0.5;
    p.reasons.push("The column has no values.");
    return p;
  }
  const st = numStats(vals);
  p.stats = st;
  p.isInteger = allInt;
  const tokens = nameTokens(col.name);
  const lowerName = col.name.toLowerCase();
  const uniqueFrac = p.distinctPct / 100;
  const nameMeaning = numericMeaningFromName(col.name);
  const hasIdWord = tokens.some((t) => ID_WORDS.has(t));

  // 1) two-valued 0/1 column → boolean flag
  if (allInt && seen.size <= 2 && present > 4 && [...seen].every((v) => v === 0 || v === 1)) {
    p.type = "boolean"; p.role = "boolean"; p.groupable = true; p.chartDimension = true; p.confidence = 0.85;
    p.reasons.push("Only the values 0 and 1 appear, so it is treated as a yes/no flag.");
    return p;
  }
  // 2) calendar parts (Year, Month…) are dimensions, not measures
  if (allInt && tokens.some((t) => CALENDAR_WORDS.has(t)) && st.max - st.min <= 366 && !nameMeaning) {
    p.type = "categorical"; p.role = "dimension"; p.subtypes.push("calendar_part");
    p.groupable = true; p.chartDimension = seen.size <= 60; p.confidence = 0.8;
    p.reasons.push(`"${col.name}" looks like a calendar part (${st.min}–${st.max}); summing it would be meaningless, so it is grouped by rather than aggregated.`);
    return p;
  }
  // 3) identifiers: name evidence + uniqueness, or a dense integer sequence
  const isSequence = allInt && present > 4 && uniqueFrac > 0.99 && Math.abs(st.max - st.min + 1 - present) <= Math.max(1, present * 0.02);
  if ((hasIdWord && allInt && uniqueFrac >= 0.5 && !nameMeaning) || isSequence || (allInt && uniqueFrac > 0.98 && seen.size > 50 && !nameMeaning && !tokens.some((t) => NON_ADDITIVE_WORDS.has(t)))) {
    p.type = "identifier"; p.role = "identifier"; p.analyzable = false; p.groupable = true; p.confidence = isSequence ? 0.95 : 0.8;
    const idMeaning = stringMeaningFromName(col.name);
    if (idMeaning && (idMeaning.meaning === "customer" || idMeaning.meaning === "product")) {
      p.meaning = idMeaning.meaning; p.meaningConfidence = 0.7; p.subtypes.push("entity");
    }
    p.reasons.push(isSequence
      ? "A dense, gap-free integer sequence is a row index, not a measure — summing it would give a meaningless total."
      : `Almost every value is unique${hasIdWord ? " and the name marks it as an identifier" : ""}.`);
    return p;
  }
  // 4) coordinates
  if (tokens.some((t) => COORD_WORDS.has(t))) {
    p.type = "numeric"; p.role = "measure"; p.additive = false; p.defaultAgg = "avg"; p.unit = "number";
    p.subtypes.push("coordinate", "geographic"); p.analyzable = false; p.confidence = 0.85;
    p.reasons.push("Latitude/longitude-style column: averaged, never summed, and left out of automatic insights.");
    return p;
  }

  // 5) numeric measure
  p.type = "numeric"; p.role = "measure"; p.confidence = 0.95;
  p.reasons.push("Parsed as numbers.");
  p.histogram = histogram(vals, st);

  const unitInterval = st.min >= 0 && st.max <= 1.0001 && !allInt;
  const inPct = st.min >= 0 && st.max <= 100.01;
  const sumsToWhole = (st.min >= 0 && st.max <= 1.0001 && Math.abs(st.sum - 1) < 0.02) || (inPct && Math.abs(st.sum - 100) < 0.5);
  const nameNonAdd = tokens.some((t) => NON_ADDITIVE_WORDS.has(t));
  const isPercent = !!col.meta.percent || tokens.some((t) => ["pct", "percent", "percentage"].includes(t)) || (unitInterval && (nameNonAdd || nameMeaning?.meaning === "discount" || nameMeaning?.meaning === "margin"));
  if (nameMeaning) {
    p.meaning = nameMeaning.meaning;
    p.meaningConfidence = nameMeaning.score >= 1 ? 0.8 : 0.55;
    p.reasons.push(`Name suggests ${nameMeaning.meaning}.`);
  }
  if (p.meaning === "margin" || (p.meaning === "profit" && (isPercent || unitInterval))) {
    p.meaning = "margin"; // a profit *rate* is not a profit amount (safeguard 8)
    p.reasons.push("Values are a rate/percentage, so this is a margin, not a profit amount; it is never summed or divided into revenue.");
  }
  const rateLike = p.meaning === "price" || p.meaning === "discount" || p.meaning === "margin";
  const additive = !(nameNonAdd || rateLike || isPercent || unitInterval || sumsToWhole || p.meaning === "price");
  p.additive = additive;
  p.defaultAgg = additive ? "sum" : "avg";
  if (!additive) p.reasons.push(sumsToWhole ? "Values sum to a whole (a share column), so totals are not meaningful; averages are used." : "Shares, rates, prices and scores do not add up, so totals are not meaningful; averages are used.");
  if (isPercent) { p.subtypes.push("percentage"); p.unit = "percent"; }
  else if (p.meaning && MONEY_MEANINGS.has(p.meaning) || col.meta.currency) { p.subtypes.push("currency"); p.unit = "currency"; p.currency = col.meta.currency ?? null; }
  else p.unit = allInt ? "count" : "number";
  if (col.meta.currency) p.currency = col.meta.currency;
  void lowerName;
  return p;
}

function topValues(col: StringColumn, present: number, limit = 12) {
  const counts = new Uint32Array(col.dict.length);
  for (let i = 0; i < col.codes.length; i++) { const c = col.codes[i]!; if (c !== NULL_CODE) counts[c]!++; }
  let distinct = 0;
  const idx: number[] = [];
  for (let c = 0; c < counts.length; c++) if (counts[c]) { distinct++; idx.push(c); }
  idx.sort((a, b) => counts[b]! - counts[a]! || (col.dict[a]! < col.dict[b]! ? -1 : 1));
  return {
    counts, distinct,
    top: idx.slice(0, limit).map((c) => ({ value: col.dict[c]!, count: counts[c]!, pct: present ? (counts[c]! / present) * 100 : 0 })),
  };
}

function profileString(col: StringColumn, index: number, ctx: Ctx): ColumnProfile {
  let present = 0;
  for (let i = 0; i < col.codes.length; i++) if (col.codes[i] !== NULL_CODE) present++;
  const { counts, distinct, top } = topValues(col, present);
  const p = baseProfile(col.name, index, "string", ctx.n, present, distinct);
  p.top = top;
  if (!present) {
    p.type = "categorical"; p.role = "dimension"; p.analyzable = false; p.confidence = 0.5;
    p.reasons.push("The column has no values.");
    return p;
  }
  // shape / length statistics over the dictionary, weighted by frequency
  let lenSum = 0, wordSum = 0, weightSum = 0;
  const shapes = new Map<string, number>();
  let shapeSeen = 0;
  for (let c = 0; c < col.dict.length; c++) {
    const cnt = counts[c]!;
    if (!cnt) continue;
    const s = col.dict[c]!;
    lenSum += s.length * cnt;
    wordSum += (s.trim().split(/\s+/).length) * cnt;
    weightSum += cnt;
    if (shapeSeen < 3000) { const sh = shapeOf(s); shapes.set(sh, (shapes.get(sh) ?? 0) + cnt); shapeSeen++; }
  }
  p.avgLength = lenSum / weightSum;
  p.avgWords = wordSum / weightSum;
  const shapeTotal = [...shapes.values()].reduce((a, b) => a + b, 0);
  p.formatUniformity = shapeTotal ? Math.max(...shapes.values()) / shapeTotal : 0;

  const tokens = nameTokens(col.name);
  const uniqueFrac = distinct / present;
  const freeTextName = tokens.some((t) => FREE_TEXT_WORDS.has(t));
  const hasIdWord = tokens.some((t) => ID_WORDS.has(t));
  const nameMeaning = stringMeaningFromName(col.name);
  const values = col.dict;

  // 1) free text — decided BEFORE identifier so sentences are never treated as ids (safeguard 9)
  const proseLike = p.avgWords >= 3.5 || p.avgLength >= 50;
  if ((proseLike && uniqueFrac >= 0.25) || (freeTextName && p.avgWords >= 2 && uniqueFrac >= 0.25)) {
    p.type = "text"; p.role = "text"; p.analyzable = false; p.groupable = false; p.confidence = proseLike ? 0.9 : 0.75;
    p.reasons.push(`Values average ${p.avgWords.toFixed(1)} words and are mostly unique, so this is free text (a caption), not a category or an identifier.`);
    return p;
  }
  // 2) identifiers: unique or code-shaped
  const codeShaped = p.formatUniformity >= 0.9 && p.avgWords <= 1.5 && /[0-9]/.test(top[0]?.value ?? "");
  if ((uniqueFrac >= 0.9 && distinct >= 20 && p.avgWords <= 2.5) || (hasIdWord && uniqueFrac >= 0.6) || (codeShaped && uniqueFrac >= 0.5 && distinct >= 20)) {
    p.type = "identifier"; p.role = "identifier"; p.analyzable = false; p.groupable = true; p.confidence = 0.85;
    p.reasons.push(`${Math.round(uniqueFrac * 100)}% of values are unique${hasIdWord ? " and the name marks it as an identifier" : ""}${codeShaped ? "; values share one code format" : ""}.`);
    if (nameMeaning?.meaning === "customer" || nameMeaning?.meaning === "product") { p.meaning = nameMeaning.meaning; p.meaningConfidence = 0.7; p.subtypes.push("entity"); }
    return p;
  }
  // 3) categorical
  p.type = "categorical"; p.role = "dimension"; p.groupable = distinct <= 100_000;
  p.chartDimension = distinct >= 2 && distinct <= Math.max(2, Math.min(60, ctx.n / 5)) && uniqueFrac <= 0.5;
  if (!p.chartDimension) p.reasons.push(distinct <= 1 ? "Only one distinct value." : `${distinct.toLocaleString("en-US")} distinct values across ${present.toLocaleString("en-US")} rows — too many (or too unique) for a chart dimension, but usable for rankings.`);
  else p.reasons.push(`${distinct} distinct values across ${present.toLocaleString("en-US")} rows.`);
  if (nameMeaning) {
    p.meaning = nameMeaning.meaning; p.meaningConfidence = nameMeaning.score >= 1 ? 0.8 : 0.55;
    p.reasons.push(`Name suggests ${nameMeaning.meaning}.`);
    if ((nameMeaning.meaning === "customer" || nameMeaning.meaning === "product") && !p.chartDimension) p.subtypes.push("entity");
  }
  const lowerVals = values.slice(0, 400).map((v) => v.toLowerCase());
  const geoHit = lowerVals.filter((v) => COUNTRIES.has(v) || US_STATES.has(v)).length / Math.max(1, lowerVals.length);
  if (tokens.some((t) => GEO_WORDS.has(t)) || geoHit >= 0.6) {
    p.subtypes.push("geographic");
    if (!p.meaning) { p.meaning = "region"; p.meaningConfidence = geoHit >= 0.6 ? 0.85 : 0.6; }
    p.reasons.push(geoHit >= 0.6 ? "Most values are country or state names." : "Name indicates a geographic field.");
  }
  if (distinct <= 1) p.analyzable = false;
  return p;
}

function profileDate(col: DateColumn, index: number, ctx: Ctx): ColumnProfile {
  let present = 0, min = Infinity, max = -Infinity;
  const days = new Set<number>();
  for (let i = 0; i < col.values.length; i++) {
    const d = col.values[i]!;
    if (d === NULL_DATE) continue;
    present++;
    if (d < min) min = d;
    if (d > max) max = d;
    if (days.size <= 200_000) days.add(d);
  }
  const p = baseProfile(col.name, index, "date", ctx.n, present, days.size);
  p.type = col.meta.hasTime ? "datetime" : "date"; p.role = "time"; p.confidence = 0.95;
  p.reasons.push(col.meta.hasTime ? "Parsed as dates with times (time of day is ignored in period analysis)." : "Parsed as dates.");
  if (!present) { p.analyzable = false; return p; }
  const spanDays = max - min;
  const grain = pickGrain(spanDays);
  const periods = new Set<number>();
  const stride = Math.max(1, Math.floor(ctx.n / 20000));
  let sampled = 0;
  for (let i = 0; i < col.values.length; i += stride) {
    const d = col.values[i]!;
    if (d === NULL_DATE) continue;
    periods.add(periodOrdinal(d, grain));
    sampled++;
  }
  const tokens = nameTokens(col.name);
  const attr = tokens.some((t) => ATTR_DATE_WORDS.has(t));
  const specific = tokens.some((t) => EVENT_DATE_SPECIFIC.has(t));
  const generic = tokens.some((t) => EVENT_DATE_GENERIC.has(t));
  // "Signup Date": the specific attribute word outranks the generic word "date".
  const kind = attr && !specific ? "attribute" : specific || generic ? "event" : "unknown";
  const nameScore = attr && !specific ? -100 : attr && specific ? 40 : specific ? 100 : generic ? 80 : 0;
  const density = periods.size ? (sampled * stride) / periods.size : 0;
  const score = nameScore + Math.min(30, Math.log10(1 + density) * 22) - p.missingPct * 0.4;
  p.date = {
    minDay: min, maxDay: max, minIso: formatIsoDate(min), maxIso: formatIsoDate(max), spanDays, hasTime: !!col.meta.hasTime,
    kind, score, periodCount: periods.size, density, distinctDays: days.size,
  };
  p.reasons.push(kind === "attribute"
    ? "Reads like an attribute date (e.g. signup or birth), not when events happened, so it is not used as the time axis."
    : kind === "event" ? "Reads like the date events happened." : "Date purpose is unclear from its name.");
  return p;
}

function profileBoolean(col: { name: string; values: Uint8Array }, index: number, ctx: Ctx): ColumnProfile {
  let present = 0, t = 0;
  for (let i = 0; i < col.values.length; i++) { const v = col.values[i]!; if (v === NULL_BOOL) continue; present++; if (v === 1) t++; }
  const p = baseProfile(col.name, index, "boolean", ctx.n, present, (t > 0 ? 1 : 0) + (present - t > 0 ? 1 : 0));
  p.type = "boolean"; p.role = "boolean"; p.groupable = true; p.chartDimension = true;
  p.top = [{ value: "true", count: t, pct: present ? (t / present) * 100 : 0 }, { value: "false", count: present - t, pct: present ? ((present - t) / present) * 100 : 0 }];
  p.reasons.push("Yes/no values.");
  return p;
}

/* -------------------------------- dataset level ----------------------------- */

const DOMAIN_TESTS: [string, (p: ColumnProfile[], names: string) => boolean][] = [
  ["financial", (c) => c.some((x) => x.meaning === "revenue" || x.meaning === "profit" || x.meaning === "cost")],
  ["customer", (c) => c.some((x) => x.meaning === "customer")],
  ["product", (c) => c.some((x) => x.meaning === "product")],
  ["marketing", (c) => c.some((x) => x.meaning === "marketing" || x.meaning === "channel")],
  ["hr", (_c, n) => /(employee|staff|headcount|salary|hire|department)/i.test(n)],
  ["operations", (_c, n) => /(delivery|shipping|lead_?time|downtime|defect|utilization|capacity|inventory|stock|fulfil|latency|ticket|sla|duration)/i.test(n)],
  ["retention", (_c, n) => /(churn|cancel|attrit|unsub)/i.test(n)],
];

/** Adjusts meanings using arithmetic identities found in the data (statistical, not name-based, evidence). */
function applyRelations(cols: ColumnProfile[], relations: Relation[]): void {
  const by = new Map(cols.map((c) => [c.name, c]));
  const bump = (c: ColumnProfile, meaning: BusinessMeaning, conf: number, why: string) => {
    if (c.meaning && c.meaning !== meaning && c.meaningConfidence >= 0.8) return; // a confident name wins
    if (c.meaning === meaning) c.meaningConfidence = Math.max(c.meaningConfidence, conf);
    else { c.meaning = meaning; c.meaningConfidence = conf; }
    c.reasons.push(why);
    if (MONEY_MEANINGS.has(meaning) && !c.subtypes.includes("currency") && c.unit !== "percent") { c.subtypes.push("currency"); c.unit = "currency"; }
  };
  // A − B = C, A = B + C and B = A − C are one identity: canonicalise to (total, part, part) so
  // the roles are decided once, from the evidence, rather than by whichever form is seen first.
  const seen = new Set<string>();
  for (const rel of relations) {
    if (rel.kind === "product") continue;
    const total = rel.kind === "sum" ? rel.result : rel.operands[0];
    const parts = rel.kind === "sum" ? [rel.operands[0], rel.operands[1]] : [rel.result, rel.operands[1]];
    const key = `${total}|${[...parts].sort().join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const T = by.get(total), P = by.get(parts[0]!), Q = by.get(parts[1]!);
    if (!T || !P || !Q) continue;
    const why = `${T.name} ≈ ${P.name} + ${Q.name} in ${Math.round(rel.support * 100)}% of sampled rows`;
    const isCost = (c: ColumnProfile) => c.meaning === "cost" && c.meaningConfidence >= 0.5;
    const isProfit = (c: ColumnProfile) => c.meaning === "profit" && c.meaningConfidence >= 0.5;
    let profit: ColumnProfile | null = null, cost: ColumnProfile | null = null;
    if (isCost(P) && !isCost(Q)) { cost = P; profit = Q; }
    else if (isCost(Q) && !isCost(P)) { cost = Q; profit = P; }
    else if (isProfit(P) && !isProfit(Q)) { profit = P; cost = Q; }
    else if (isProfit(Q) && !isProfit(P)) { profit = Q; cost = P; }
    if (!profit || !cost) continue; // nothing tells the two parts apart — leave them unlabelled rather than guess
    bump(profit, "profit", 0.92, `${why}; with ${cost.name} as the cost, ${profit.name} is the profit.`);
    bump(cost, "cost", 0.85, `${why}; ${cost.name} is what is subtracted from ${T.name} to reach profit.`);
    bump(T, "revenue", 0.85, `${T.name} is the total in the profit identity (${why}).`);
  }
  for (const rel of relations) {
    const r = by.get(rel.result), a = by.get(rel.operands[0]), b = by.get(rel.operands[1]);
    if (!r || !a || !b) continue;
    const pct = Math.round(rel.support * 100);
    if (rel.kind === "product") {
      const why = `${r.name} ≈ ${a.name} × ${b.name} in ${pct}% of sampled rows`;
      const price = [a, b].find((x) => x.meaning === "price"), qty = [a, b].find((x) => x.meaning === "quantity");
      if (price || qty) {
        bump(r, "revenue", 0.8, `${why} (price × quantity).`);
        if (price && !qty) bump(price === a ? b : a, "quantity", 0.7, `${why}.`);
        if (qty && !price) bump(qty === a ? b : a, "price", 0.7, `${why}.`);
      }
    }
  }
}

export interface ProfileOptions {
  /** civil day for "today"; enables the future-dates quality check */
  todayDays?: number;
}

export function buildProfile(frame: Frame, clean?: CleanResult, opts: ProfileOptions = {}): DatasetProfile {
  const n = frame.rowCount;
  const ctx: Ctx = { n };
  const columns: ColumnProfile[] = frame.columns.map((c, i) => {
    switch (c.kind) {
      case "number": return profileNumber(c, i, ctx);
      case "string": return profileString(c, i, ctx);
      case "date": return profileDate(c, i, ctx);
      case "boolean": return profileBoolean(c, i, ctx);
    }
  });
  // currency picks up from the clean step (symbols seen in raw text)
  if (clean) for (const info of clean.columns) {
    const cp = columns.find((c) => c.name === info.name);
    if (cp && info.currency && cp.physical === "number") cp.currency = info.currency;
  }

  const measureNames = columns.filter((c) => c.type === "numeric" && c.analyzable && c.additive !== undefined).map((c) => c.name);
  const relations = detectRelations(frame, measureNames);
  applyRelations(columns, relations);

  // dataset-level currency: the most common currency code among money columns
  const cur = new Map<string, number>();
  for (const c of columns) if (c.currency) cur.set(c.currency, (cur.get(c.currency) ?? 0) + 1);
  const currency = [...cur.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (currency) for (const c of columns) if (c.unit === "currency" && !c.currency) c.currency = currency;

  // primary event date
  const dateCols = columns.filter((c) => c.date).sort((a, b) => b.date!.score - a.date!.score || b.date!.spanDays - a.date!.spanDays);
  const primary = dateCols.find((c) => c.date!.kind !== "attribute" && c.date!.distinctDays >= 2) ?? null;
  let calendar: CalendarInfo | null = null;
  if (primary) {
    const grain = pickGrain(primary.date!.spanDays);
    try {
      const series = buildTimeSeries(frame, null, { dateColumn: primary.name, agg: "count", grain });
      const cp = completePeriods(series);
      const pts = cp.points;
      calendar = {
        dateColumn: primary.name, grain, minDay: series.minDay, maxDay: series.maxDay,
        minIso: formatIsoDate(series.minDay), maxIso: formatIsoDate(series.maxDay),
        periods: series.points.length, completePeriods: pts.length, trimmedStart: cp.trimmedStart, trimmedEnd: cp.trimmedEnd,
        missingPeriods: series.missingOrdinals.length,
        firstCompleteKey: pts.length ? periodKey(pts[0]!.ord, grain) : null,
        lastCompleteKey: pts.length ? periodKey(pts[pts.length - 1]!.ord, grain) : null,
        notes: cp.notes,
      };
    } catch { calendar = null; }
    primary.reasons.push("Chosen as the primary time axis: it looks like an event date and its periods are densely populated.");
  }

  const dup = clean ? { count: clean.duplicateRows } : { count: duplicateMaskOf(frame).count };
  const missingCells = columns.reduce((a, c) => a + c.missing, 0);
  const names = columns.map((c) => c.name).join(" ");
  const profile: DatasetProfile = {
    version: ANALYSIS_VERSION, rowCount: n, columnCount: columns.length, columns,
    duplicateRows: dup.count, duplicatePct: n ? (dup.count / n) * 100 : 0,
    missingCells, missingPct: n && columns.length ? (missingCells / (n * columns.length)) * 100 : 0,
    primaryDate: primary ? primary.name : null, calendar,
    domain: DOMAIN_TESTS.filter(([, t]) => t(columns, names)).map(([k]) => k),
    relations, currency,
    quality: { score: 100, label: "Excellent", completeness: 100, issues: [], counts: { high: 0, medium: 0, low: 0 } },
    capabilities: undefined as never,
  };
  profile.quality = buildQualityReport(profile, clean, { todayDays: opts.todayDays });
  profile.capabilities = buildCapabilities(profile);
  return profile;
}
