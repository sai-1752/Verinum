/**
 * The fact ledger: every number the analysis produced in this conversation turn, plus the labels
 * (entity values, column names) whose digits must not be mistaken for claims. The validator asks
 * one question of every number in an answer: does a fact in this ledger support it?
 */
import type { Fact, ToolResult } from "../facts";
import { extractNumericClaims, type NumericClaim } from "./numbers";

export interface LedgerFact extends Fact {
  /** tool-call id (or "user"/"dataset") the fact came from */
  source: string;
}

export type MismatchReason = "no_match" | "currency_symbol" | "direction";

export interface ClaimCheck {
  claim: NumericClaim;
  ok: boolean;
  fact?: LedgerFact;
  reason?: MismatchReason;
}

export interface ValidationReport {
  ok: boolean;
  checks: ClaimCheck[];
  unverified: ClaimCheck[];
}

const UP = /\b(rose|rise|rising|risen|increase[ds]?|increasing|grew|grow|grown|growth|gain(?:ed|s)?|up|higher|climb(?:ed|s)?|jump(?:ed|s)?|surg(?:e|ed|es)|improv(?:e|ed|es|ing))\b/i;
const DOWN = /\b(fell|fall|falling|fallen|decrease[ds]?|decreasing|declin(?:e|ed|es|ing)|drop(?:ped|s)?|down|lower|shrank|shrink(?:s|ing)?|dip(?:ped|s)?|slump(?:ed|s)?|eroded|erod(?:e|es|ing)|worsen(?:ed|s|ing)?)\b/i;

export function directionCue(text: string): "up" | "down" | null {
  const up = UP.test(text), down = DOWN.test(text);
  return up && !down ? "up" : down && !up ? "down" : null;
}

/** A formatted quantity ("506.5K", "15.7%", "$1,204.50", "-3.2 pts") is a claim to verify, never a label to ignore. */
const QUANTITY_STRING = /^\s*[-+−]?\s*[$€£¥₹]?\s*[-+−]?\d[\d,]*(\.\d+)?\s*([KMBkmb]|%|x|×|pts?|pp|percent)?\s*$/;

function collectStrings(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || v === null || v === undefined) return;
  if (typeof v === "string") { if (v.length <= 80 && !QUANTITY_STRING.test(v)) out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 500)) collectStrings(x, out, depth + 1); return; }
  if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out, depth + 1);
}

function collectNumbers(v: unknown, path: string, out: { path: string; n: number }[], depth = 0): void {
  if (depth > 4 || v === null || v === undefined) return;
  if (typeof v === "number") { if (Number.isFinite(v)) out.push({ path, n: v }); return; }
  if (Array.isArray(v)) { v.slice(0, 20).forEach((x, i) => collectNumbers(x, `${path}[${i}]`, out, depth + 1)); return; }
  if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) collectNumbers(x, path ? `${path}.${k}` : k, out, depth + 1);
}

export class FactLedger {
  private readonly facts: LedgerFact[] = [];
  private readonly labelSet = new Set<string>();
  private nextId = 1;

  get size(): number { return this.facts.length; }
  all(): readonly LedgerFact[] { return this.facts; }
  labels(): ReadonlySet<string> { return this.labelSet; }

  addLabels(labels: Iterable<string>): void { for (const l of labels) if (l) this.labelSet.add(l); }

  addFacts(source: string, facts: Fact[]): void {
    for (const f of facts) this.facts.push({ ...f, id: `${source}:${f.id}`, source });
  }

  /** Numbers in the tool's parameters (limit=5, horizon=3, filter values) are facts the model may echo back. */
  addParams(source: string, params: Record<string, unknown>): void {
    const nums: { path: string; n: number }[] = [];
    collectNumbers(params, "", nums);
    for (const { path, n } of nums) {
      this.facts.push({ id: `${source}:param:${path}`, label: `parameter ${path}`, value: n, unit: "count", display: String(n), source });
    }
  }

  /** Records a tool result: its facts, its parameters, and every string in its data as a label. */
  addResult(callId: string, r: Pick<ToolResult, "facts" | "data" | "provenance">): void {
    this.addFacts(callId, r.facts);
    this.addParams(callId, r.provenance.params);
    const s = new Set<string>();
    collectStrings(r.data, s);
    collectStrings(r.provenance.filters, s);
    this.addLabels(s);
  }

  /** Numbers the user typed themselves may be echoed (e.g. "orders above 500"). */
  addUserText(text: string): void {
    for (const c of extractNumericClaims(text, { labels: this.labelSet, spelledNumbers: false })) {
      this.facts.push({ id: `user:${this.nextId++}`, label: "stated by the user", value: c.negative ? -c.value : c.value, unit: c.kind === "percent" ? "percent" : c.kind === "currency" ? "currency" : "count", display: c.raw, source: "user" });
    }
  }

  extract(text: string): NumericClaim[] {
    return extractNumericClaims(text, { labels: this.labelSet });
  }

  private matchOne(claim: NumericClaim, f: LedgerFact, context: string): { ok: boolean; reason?: MismatchReason } {
    if (typeof f.value !== "number") return { ok: false };
    const unit = f.unit;
    // unit compatibility
    if (claim.kind === "percent" && unit !== "percent") return { ok: false };
    if (claim.kind === "ratio" && unit !== "ratio") return { ok: false };
    if (claim.kind === "currency" && unit !== "currency" && unit !== "number") return { ok: false };
    if ((claim.kind === "plain" || claim.kind === "word") && unit === "percent") {
      // "0.31" stated for a 31.2% fact
      if (!(claim.value <= 1 && Math.abs(claim.value - Math.abs(f.value) / 100) <= claim.tolerance + 1e-12)) return { ok: false };
      return { ok: true };
    }
    const diff = Math.abs(claim.value - Math.abs(f.value));
    // multiples of K/M/B: the tolerance already reflects the shown precision; also allow the fact's own display rounding
    if (diff > claim.tolerance + 1e-9) return { ok: false };
    if (claim.symbol && unit === "currency" && !f.display.includes(claim.symbol)) return { ok: false, reason: "currency_symbol" };
    if (f.display.startsWith("+") || f.display.startsWith("-")) {
      const cue = directionCue(context);
      if (cue && !claim.negative && ((cue === "up" && f.value < 0) || (cue === "down" && f.value > 0))) return { ok: false, reason: "direction" };
    }
    return { ok: true };
  }

  /** Checks one claim; `context` is the sentence, used only for the direction cue. */
  checkClaim(claim: NumericClaim, context = ""): ClaimCheck {
    let symbolMiss = false, directionMiss = false;
    for (const f of this.facts) {
      const r = this.matchOne(claim, f, context);
      if (r.ok) return { claim, ok: true, fact: f };
      if (r.reason === "currency_symbol") symbolMiss = true;
      if (r.reason === "direction") directionMiss = true;
    }
    return { claim, ok: false, reason: symbolMiss ? "currency_symbol" : directionMiss ? "direction" : "no_match" };
  }

  validateText(text: string): ValidationReport {
    const checks = this.extract(text).map((c) => this.checkClaim(c, text));
    const unverified = checks.filter((c) => !c.ok);
    return { ok: unverified.length === 0, checks, unverified };
  }
}
