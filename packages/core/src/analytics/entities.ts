import { Frame, NULL_CODE, NULL_DATE, rowCountOf, type RowSet } from "../frame";
import { periodKey, periodOrdinal, type Grain } from "../time";
import { concentration, type Concentration } from "./concentration";
import { AnalyticsError } from "./errors";
import { groupBy, type GroupRow } from "./groupby";

export interface CustomerAnalysis {
  customerColumn: string;
  metric: string | null;
  distinct: number;
  rowsConsidered: number;
  rowsWithoutCustomer: number;
  repeat: { withMultipleRows: number; ratePct: number; avgRowsPerCustomer: number };
  value: {
    total: number | null;
    averagePerCustomer: number | null;
    top: GroupRow[];
    topDecileShare: number | null;
    topDecileCount: number;
    concentration: Concentration | null;
  };
  newVsReturning?: { grain: Grain; points: { period: string; newCustomers: number; returningCustomers: number }[] };
}

/** Customer/entity behaviour: repeat rate, value concentration and (with a date) new vs returning. */
export function customerAnalysis(
  frame: Frame, rows: RowSet,
  o: { customer: string; metric?: string; dateColumn?: string; grain?: Grain; topN?: number; maxOrd?: number; minOrd?: number },
): CustomerAnalysis {
  const cc = frame.require(o.customer);
  if (cc.kind !== "string" && cc.kind !== "number") throw new AnalyticsError("wrong_type", `"${o.customer}" cannot identify customers.`);
  const g = groupBy(frame, rows, { dimension: o.customer, metric: o.metric, agg: o.metric ? "sum" : "count" });
  const real = g.groups.filter((x) => !x.isBlank);
  const distinct = real.length;
  if (!distinct) throw new AnalyticsError("insufficient_data", `"${o.customer}" has no values in the selected rows.`);
  const withMultiple = real.filter((x) => x.rows > 1).length;
  const totalRows = real.reduce((s, x) => s + x.rows, 0);
  const total = g.total;
  const topN = Math.max(1, Math.ceil(distinct * 0.1));
  const vals = real.map((x) => x.value);
  const topDecile = total ? (vals.slice(0, topN).reduce((s, v) => s + Math.max(0, v), 0) / vals.reduce((s, v) => s + Math.max(0, v), 0)) * 100 : null;
  const out: CustomerAnalysis = {
    customerColumn: o.customer, metric: o.metric ?? null, distinct, rowsConsidered: g.rowsConsidered, rowsWithoutCustomer: g.blankRows,
    repeat: { withMultipleRows: withMultiple, ratePct: (withMultiple / distinct) * 100, avgRowsPerCustomer: totalRows / distinct },
    value: {
      total, averagePerCustomer: total !== null ? total / distinct : null, top: real.slice(0, o.topN ?? 10),
      topDecileShare: topDecile, topDecileCount: topN, concentration: concentration(vals, topN),
    },
  };

  if (o.dateColumn) {
    const grain = o.grain ?? "month";
    const dc = frame.date(o.dateColumn);
    const first = new Map<number, number>();
    const total2 = rowCountOf(frame, rows);
    const active = new Map<number, Set<number>>();
    for (let k = 0; k < total2; k++) {
      const i = rows ? rows[k]! : k;
      const d = dc.values[i]!;
      if (d === NULL_DATE) continue;
      const key = customerKey(cc, i);
      if (key === null) continue;
      const ord = periodOrdinal(d, grain);
      const f = first.get(key);
      if (f === undefined || ord < f) first.set(key, ord);
      let s = active.get(ord);
      if (!s) { s = new Set(); active.set(ord, s); }
      s.add(key);
    }
    const ords = [...active.keys()].sort((a, b) => a - b)
      .filter((o2) => (o.minOrd === undefined || o2 >= o.minOrd) && (o.maxOrd === undefined || o2 <= o.maxOrd));
    out.newVsReturning = {
      grain,
      points: ords.map((ord) => {
        let n = 0, r = 0;
        for (const c of active.get(ord)!) { if (first.get(c) === ord) n++; else r++; }
        return { period: periodKey(ord, grain), newCustomers: n, returningCustomers: r };
      }),
    };
  }
  return out;
}

function customerKey(c: { kind: string; codes?: Uint32Array; values?: Float64Array }, i: number): number | null {
  if (c.kind === "string") return c.codes![i] === NULL_CODE ? null : c.codes![i]!;
  const v = c.values![i]!;
  return v === v ? v : null;
}

/* --------------------------------- cohorts --------------------------------- */

export interface CohortResult {
  grain: Grain;
  /** cohort → retained customers by periods since first activity */
  cohorts: { cohort: string; size: number; retention: (number | null)[]; retainedPct: (number | null)[] }[];
  maxOffset: number;
}

export function cohortAnalysis(
  frame: Frame, rows: RowSet,
  o: { customer: string; dateColumn: string; grain?: Grain; minOrd?: number; maxOrd?: number; maxCohorts?: number; maxOffset?: number },
): CohortResult {
  const grain = o.grain ?? "month";
  const cc = frame.require(o.customer);
  const dc = frame.date(o.dateColumn);
  const total = rowCountOf(frame, rows);
  const active = new Map<number, Set<number>>();
  const first = new Map<number, number>();
  for (let k = 0; k < total; k++) {
    const i = rows ? rows[k]! : k;
    const d = dc.values[i]!;
    if (d === NULL_DATE) continue;
    const key = customerKey(cc as any, i);
    if (key === null) continue;
    const ord = periodOrdinal(d, grain);
    if ((o.minOrd !== undefined && ord < o.minOrd) || (o.maxOrd !== undefined && ord > o.maxOrd)) continue;
    let s = active.get(ord);
    if (!s) { s = new Set(); active.set(ord, s); }
    s.add(key);
    const f = first.get(key);
    if (f === undefined || ord < f) first.set(key, ord);
  }
  const ords = [...active.keys()].sort((a, b) => a - b);
  if (ords.length < 3) throw new AnalyticsError("insufficient_data", "Cohort analysis needs at least three complete periods of activity.");
  const lastOrd = ords[ords.length - 1]!;
  const maxOffset = Math.min(o.maxOffset ?? 12, lastOrd - ords[0]!);
  const byCohort = new Map<number, number[]>();
  for (const [c, f] of first) { const arr = byCohort.get(f); if (arr) arr.push(c); else byCohort.set(f, [c]); }
  const cohortOrds = [...byCohort.keys()].sort((a, b) => a - b).slice(-(o.maxCohorts ?? 12));
  const cohorts = cohortOrds.map((co) => {
    const members = byCohort.get(co)!;
    const retention: (number | null)[] = [], pct: (number | null)[] = [];
    for (let off = 0; off <= maxOffset; off++) {
      if (co + off > lastOrd) { retention.push(null); pct.push(null); continue; }
      const set = active.get(co + off);
      const n = set ? members.filter((m) => set.has(m)).length : 0;
      retention.push(n); pct.push((n / members.length) * 100);
    }
    return { cohort: periodKey(co, grain), size: members.length, retention, retainedPct: pct };
  });
  return { grain, cohorts, maxOffset };
}

/* ---------------------------------- funnel --------------------------------- */

export interface FunnelResult {
  stageColumn: string;
  mode: "snapshot" | "events";
  stages: { stage: string; count: number; reached: number; conversionFromPrevious: number | null; conversionFromFirst: number | null }[];
  biggestDropOff: { from: string; to: string; lostPct: number } | null;
  orderSource: "provided" | "inferred";
}

const KNOWN_ORDERS: string[][] = [
  ["lead", "prospect", "mql", "sql", "qualified", "opportunity", "proposal", "negotiation", "won", "closed won", "customer"],
  ["visit", "visitor", "view", "product view", "add to cart", "cart", "checkout", "purchase", "order"],
  ["impression", "click", "signup", "sign up", "trial", "activation", "activated", "paid", "subscribed"],
  ["applied", "screened", "screening", "interview", "offer", "offered", "hired", "accepted"],
];

export function inferStageOrder(labels: string[]): string[] | null {
  const lower = new Map(labels.map((l) => [l.toLowerCase(), l]));
  let best: string[] | null = null;
  for (const order of KNOWN_ORDERS) {
    const hits = order.filter((s) => lower.has(s));
    if (hits.length >= 3 && hits.length >= labels.length * 0.6 && (!best || hits.length > best.length)) best = hits;
  }
  return best ? best.map((s) => lower.get(s)!) : null;
}

export function funnelAnalysis(
  frame: Frame, rows: RowSet, o: { stageColumn: string; stageOrder?: string[]; entityColumn?: string },
): FunnelResult {
  const sc = frame.string(o.stageColumn);
  let order = o.stageOrder;
  let orderSource: FunnelResult["orderSource"] = "provided";
  if (!order || order.length < 2) {
    order = inferStageOrder(sc.dict) ?? undefined;
    orderSource = "inferred";
    if (!order) throw new AnalyticsError("invalid_argument", `The order of the stages in "${o.stageColumn}" could not be inferred.`, `Provide stage_order, listing the stages from first to last. Values present: ${sc.dict.slice(0, 15).join(", ")}`);
  }
  const lowerIdx = new Map(order.map((s, i) => [s.toLowerCase(), i]));
  const stageOfCode = sc.dict.map((d) => lowerIdx.get(d.toLowerCase()) ?? -1);
  const total = rowCountOf(frame, rows);
  const counts = new Array<number>(order.length).fill(0);
  let mode: FunnelResult["mode"] = "snapshot";
  if (o.entityColumn) {
    const ec = frame.require(o.entityColumn);
    const perEntity = new Map<number, Set<number>>();
    for (let k = 0; k < total; k++) {
      const i = rows ? rows[k]! : k;
      const code = sc.codes[i]!;
      if (code === NULL_CODE) continue;
      const st = stageOfCode[code]!;
      if (st < 0) continue;
      const key = ec.kind === "string" ? (ec.codes[i] === NULL_CODE ? null : ec.codes[i]!) : ec.kind === "number" ? (ec.values[i]! === ec.values[i]! ? ec.values[i]! : null) : null;
      if (key === null) continue;
      let s = perEntity.get(key);
      if (!s) { s = new Set(); perEntity.set(key, s); }
      s.add(st);
    }
    let multi = 0;
    for (const s of perEntity.values()) if (s.size > 1) multi++;
    mode = multi / Math.max(1, perEntity.size) > 0.2 ? "events" : "snapshot";
    for (const s of perEntity.values()) {
      if (mode === "events") for (const st of s) counts[st]!++;
      else counts[Math.max(...s)]!++;
    }
  } else {
    for (let k = 0; k < total; k++) {
      const i = rows ? rows[k]! : k;
      const code = sc.codes[i]!;
      if (code === NULL_CODE) continue;
      const st = stageOfCode[code]!;
      if (st >= 0) counts[st]!++;
    }
  }
  // snapshot mode: an entity at stage k has "reached" every earlier stage
  const reached = mode === "snapshot" ? counts.map((_, i) => counts.slice(i).reduce((a, b) => a + b, 0)) : counts.slice();
  if (!reached[0]) throw new AnalyticsError("insufficient_data", `No rows are in the first stage ("${order[0]}").`);
  const stages = order.map((stage, i) => ({
    stage, count: counts[i]!, reached: reached[i]!,
    conversionFromPrevious: i === 0 ? null : reached[i - 1] ? (reached[i]! / reached[i - 1]!) * 100 : null,
    conversionFromFirst: (reached[i]! / reached[0]!) * 100,
  }));
  let worst: FunnelResult["biggestDropOff"] = null;
  for (let i = 1; i < stages.length; i++) {
    const c = stages[i]!.conversionFromPrevious;
    if (c !== null && (worst === null || 100 - c > worst.lostPct)) worst = { from: stages[i - 1]!.stage, to: stages[i]!.stage, lostPct: 100 - c };
  }
  return { stageColumn: o.stageColumn, mode, stages, biggestDropOff: worst, orderSource };
}
