import { Frame, type RowSet } from "../frame";
import { pearson, spearman } from "../stats";
import { AnalyticsError } from "./errors";

/** A detected arithmetic relationship between columns (e.g. Profit = Sales − Cost). */
export interface Relation {
  kind: "difference" | "product" | "sum";
  result: string;
  operands: [string, string];
  /** share of sampled rows for which the identity holds within 1% */
  support: number;
}

export interface CorrPair {
  a: string;
  b: string;
  r: number;
  spearman: number | null;
  n: number;
  p: number;
  tautological: boolean;
  reason?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function sampleIndices(frame: Frame, rows: RowSet, max: number): Uint32Array {
  const total = rows ? rows.length : frame.rowCount;
  const stride = Math.max(1, Math.floor(total / max));
  const out = new Uint32Array(Math.ceil(total / stride));
  let m = 0;
  for (let k = 0; k < total; k += stride) out[m++] = rows ? rows[k]! : k;
  return out.slice(0, m);
}

function extract(frame: Frame, name: string, idx: Uint32Array): Float64Array {
  const c = frame.number(name).values;
  const out = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) out[k] = c[idx[k]!]!;
  return out;
}

/**
 * Why a correlation would be meaningless: one name contains the other, |r| ≈ 1, a constant
 * ratio between the columns (a share, rate or unit conversion), or a known arithmetic identity
 * (safeguard 7). The prototype applied this only in its insight generator, not in the tool the
 * AI called, so tautologies leaked through to answers.
 */
export function tautologyReason(a: string, b: string, xs: Float64Array, ys: Float64Array, r: number, relations: Relation[] = []): string | null {
  const na = norm(a), nb = norm(b);
  if (na && nb && (na.includes(nb) || nb.includes(na))) return `"${a}" and "${b}" look like the same quantity (one name contains the other).`;
  if (Math.abs(r) >= 0.99) return `r = ${r.toFixed(3)} is too close to 1 to be a finding; one column is almost certainly derived from the other.`;
  const ratios: number[] = [];
  for (let i = 0; i < xs.length && ratios.length < 400; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (x !== x || y !== y || y === 0) continue;
    ratios.push(x / y);
  }
  if (ratios.length >= 8) {
    const m = ratios.reduce((s, v) => s + v, 0) / ratios.length;
    if (m !== 0) {
      const sd = Math.sqrt(ratios.reduce((s, v) => s + (v - m) ** 2, 0) / ratios.length);
      if (Math.abs(sd / m) < 0.02) return `"${a}" is a constant multiple of "${b}" (a share, rate or unit conversion).`;
    }
  }
  for (const rel of relations) {
    if ((rel.result === a && rel.operands.includes(b)) || (rel.result === b && rel.operands.includes(a))) {
      const [x, y] = rel.operands;
      return `${rel.result} is computed from ${x} and ${y} (${rel.kind}), so their relationship is arithmetic rather than behavioural.`;
    }
  }
  return null;
}

export interface CorrOptions {
  maxSample?: number;
  relations?: Relation[];
  spearmanForTop?: number;
}

/** All pairwise correlations among `columns`, sorted by |r|, each flagged if tautological. */
export function correlationPairs(frame: Frame, rows: RowSet, columns: string[], opts: CorrOptions = {}): CorrPair[] {
  const idx = sampleIndices(frame, rows, opts.maxSample ?? 50_000);
  const data = new Map<string, Float64Array>(columns.map((c) => [c, extract(frame, c, idx)]));
  const out: CorrPair[] = [];
  for (let i = 0; i < columns.length; i++) for (let j = i + 1; j < columns.length; j++) {
    const a = columns[i]!, b = columns[j]!;
    const xs = data.get(a)!, ys = data.get(b)!;
    const c = pearson(xs, ys);
    if (!c) continue;
    const reason = tautologyReason(a, b, xs, ys, c.r, opts.relations);
    out.push({ a, b, r: c.r, spearman: null, n: c.n, p: c.p, tautological: !!reason, reason: reason ?? undefined });
  }
  out.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  const top = opts.spearmanForTop ?? 8;
  for (let i = 0; i < Math.min(top, out.length); i++) {
    const s = spearman(data.get(out[i]!.a)!, data.get(out[i]!.b)!);
    out[i]!.spearman = s ? s.r : null;
  }
  return out;
}

export function correlate(frame: Frame, rows: RowSet, a: string, b: string, relations: Relation[] = []): CorrPair {
  for (const c of [a, b]) {
    const col = frame.get(c);
    if (!col) throw new AnalyticsError("unknown_column", `Column "${c}" does not exist.`, `Available columns: ${frame.names().join(", ")}`);
    if (col.kind !== "number") throw new AnalyticsError("wrong_type", `"${c}" is a ${col.kind} column; correlation needs numeric columns.`);
  }
  const idx = sampleIndices(frame, rows, 200_000);
  const xs = extract(frame, a, idx), ys = extract(frame, b, idx);
  const c = pearson(xs, ys);
  if (!c) throw new AnalyticsError("insufficient_data", `There are not enough paired values (or no variation) in "${a}" and "${b}" to correlate them.`);
  const s = spearman(xs, ys);
  const reason = tautologyReason(a, b, xs, ys, c.r, relations);
  return { a, b, r: c.r, spearman: s ? s.r : null, n: c.n, p: c.p, tautological: !!reason, reason: reason ?? undefined };
}

/**
 * Finds arithmetic identities among numeric columns on a sample of rows:
 * A ≈ B − C (profit = revenue − cost), A ≈ B × C (revenue = quantity × price), A ≈ B + C.
 * Used both to corroborate column meanings and to suppress tautological correlations.
 */
export function detectRelations(frame: Frame, columns: string[], sample = 600): Relation[] {
  if (columns.length < 3) return [];
  const idx = sampleIndices(frame, null, sample);
  const data = new Map<string, Float64Array>(columns.map((c) => [c, extract(frame, c, idx)]));
  const out: Relation[] = [];
  const holds = (f: (i: number) => number | null, res: Float64Array): number => {
    let ok = 0, tot = 0;
    for (let i = 0; i < res.length; i++) {
      const target = res[i]!;
      const v = f(i);
      if (v === null || target !== target) continue;
      tot++;
      const tol = Math.max(0.01 * Math.abs(target), 0.011);
      if (Math.abs(v - target) <= tol) ok++;
    }
    return tot >= 20 ? ok / tot : 0;
  };
  const cols = columns.slice(0, 14);
  for (const res of cols) {
    const R = data.get(res)!;
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
      const b = cols[i]!, c = cols[j]!;
      if (b === res || c === res) continue;
      const B = data.get(b)!, C = data.get(c)!;
      const d1 = holds((k) => (B[k]! === B[k]! && C[k]! === C[k]! ? B[k]! - C[k]! : null), R);
      if (d1 >= 0.9) { out.push({ kind: "difference", result: res, operands: [b, c], support: d1 }); continue; }
      const d2 = holds((k) => (B[k]! === B[k]! && C[k]! === C[k]! ? C[k]! - B[k]! : null), R);
      if (d2 >= 0.9) { out.push({ kind: "difference", result: res, operands: [c, b], support: d2 }); continue; }
      const p = holds((k) => (B[k]! === B[k]! && C[k]! === C[k]! ? B[k]! * C[k]! : null), R);
      if (p >= 0.9) { out.push({ kind: "product", result: res, operands: [b, c], support: p }); continue; }
      const s = holds((k) => (B[k]! === B[k]! && C[k]! === C[k]! ? B[k]! + C[k]! : null), R);
      if (s >= 0.9) out.push({ kind: "sum", result: res, operands: [b, c], support: s });
    }
  }
  return out.sort((a, b) => b.support - a.support);
}
