import { RANK_WEIGHTS, type Candidate, type Insight, type RankFactors } from "./types";

export const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export const CONFIDENCE_VALUE = { high: 1, medium: 0.7, low: 0.4 } as const;

/** Score = 100 × Σ weight·factor. Deterministic and explainable. */
export function scoreOf(f: RankFactors): number {
  let s = 0;
  for (const k of Object.keys(RANK_WEIGHTS) as (keyof RankFactors)[]) s += RANK_WEIGHTS[k] * clamp01(f[k]);
  return Math.round(s * 1000) / 10;
}

export const priorityOf = (score: number): Insight["priority"] => (score >= 68 ? "high" : score >= 52 ? "medium" : "low");

export interface RankOptions {
  max?: number;
  perKindCap?: number;
  minScore?: number;
}

/**
 * Ranks candidates, applies diversity (repeats of the same kind+subject are down-weighted via the
 * novelty factor), caps per kind, and drops findings below the significance floor.
 */
export function rankCandidates(cands: Candidate[], o: RankOptions = {}): { insights: Insight[]; belowThreshold: number; duplicatesOfKind: number } {
  const max = o.max ?? 14, perKind = o.perKindCap ?? 3, minScore = o.minScore ?? 40;
  const base = cands.map((c) => ({ c, score: scoreOf(c.factors) }));
  base.sort((a, b) => b.score - a.score || (a.c.id < b.c.id ? -1 : 1));
  const seenSubject = new Map<string, number>(), seenKind = new Map<string, number>();
  const out: Insight[] = [];
  let below = 0, dup = 0;
  for (const { c } of base) {
    const sk = `${c.kind}|${c.subject}`;
    const subjectCount = seenSubject.get(sk) ?? 0;
    const kindCount = seenKind.get(c.kind) ?? 0;
    if (kindCount >= perKind) { dup++; continue; }
    const novelty = Math.min(c.factors.novelty, Math.pow(0.6, subjectCount));
    const factors = { ...c.factors, novelty };
    const score = scoreOf(factors);
    if (score < minScore) { below++; continue; }
    seenSubject.set(sk, subjectCount + 1);
    seenKind.set(c.kind, kindCount + 1);
    const { subject: _s, ...rest } = c;
    void _s;
    out.push({ ...rest, factors, score, priority: priorityOf(score) });
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return { insights: out.slice(0, max), belowThreshold: below, duplicatesOfKind: dup + Math.max(0, out.length - max) };
}
