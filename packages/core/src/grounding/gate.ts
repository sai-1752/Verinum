/**
 * SentenceGate: streams an answer to the user one *verified* sentence at a time. A sentence that
 * asserts a number the ledger cannot support is dropped (and counted) instead of shown, so an
 * untraceable statistic can never reach the screen — not even briefly, because nothing is emitted
 * before its sentence is complete and checked.
 */
import { FactLedger } from "./ledger";

export interface DroppedSentence { text: string; unverified: string[]; reason: string }

export interface GateStats {
  sentences: number;
  numericSentences: number;
  dropped: number;
  droppedSentences: DroppedSentence[];
}

const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|approx|no|dr|mr|ms|mrs|inc|ltd|co|st|fig|cf|al)\.$/i;

/** Index just past the end of the first complete sentence in `buf` (including trailing whitespace on the same line), or -1. */
function sentenceEnd(buf: string, final: boolean): number {
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]!;
    if (ch === "\n") {
      let j = i + 1;
      while (j < buf.length && buf[j] === "\n") j++;
      if (j < buf.length || final) return j;
      return -1; // more newlines may follow
    }
    if (ch === "." || ch === "!" || ch === "?") {
      const next = buf[i + 1];
      if (next === undefined) { if (final) return i + 1; return -1; }
      if (/[\s]/.test(next)) {
        if (ch === "." && ABBREV.test(buf.slice(Math.max(0, i - 8), i + 1))) continue;
        // digit-dot-space at a line start is a list marker, not a sentence end
        if (ch === "." && /(^|\n)\s*\d{1,3}$/.test(buf.slice(0, i))) continue;
        let j = i + 1;
        while (j < buf.length && buf[j] === " ") j++;
        if (j < buf.length || final) return j;
        return -1;
      }
      // closing quote/bracket after the terminator
      if (/["')\]]/.test(next) && (buf[i + 2] === undefined || /\s/.test(buf[i + 2]!))) {
        let j = i + 2;
        while (j < buf.length && buf[j] === " ") j++;
        if (j < buf.length || final || buf[i + 2] === undefined) return buf[i + 2] === undefined && !final ? -1 : j;
      }
    }
  }
  return -1;
}

export class SentenceGate {
  private buf = "";
  readonly stats: GateStats = { sentences: 0, numericSentences: 0, dropped: 0, droppedSentences: [] };

  constructor(private readonly ledger: FactLedger, private readonly onDrop?: (d: DroppedSentence) => void) {}

  private check(sentence: string): string {
    const body = sentence.trim();
    if (!body) return sentence;
    this.stats.sentences++;
    const claims = this.ledger.extract(body);
    if (!claims.length) return sentence;
    this.stats.numericSentences++;
    const checks = claims.map((c) => this.ledger.checkClaim(c, body));
    const bad = checks.filter((c) => !c.ok);
    if (!bad.length) return sentence;
    this.stats.dropped++;
    const d: DroppedSentence = {
      text: body,
      unverified: bad.map((b) => b.claim.raw),
      reason: bad[0]!.reason === "currency_symbol" ? "currency symbol not present in the data" : bad[0]!.reason === "direction" ? "direction contradicts the computed change" : "number not found in any tool result",
    };
    this.stats.droppedSentences.push(d);
    this.onDrop?.(d);
    // keep paragraph structure: preserve trailing newlines of the dropped sentence
    const nl = /\n+$/.exec(sentence);
    return nl ? nl[0] : "";
  }

  /** Feed streamed text; returns the verified text that is safe to display now. */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      const end = sentenceEnd(this.buf, false);
      if (end < 0) break;
      out += this.check(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
    }
    return out;
  }

  /** End of stream: verifies whatever is left. */
  flush(): string {
    let out = "";
    for (;;) {
      if (!this.buf) break;
      const end = sentenceEnd(this.buf, true);
      const cut = end < 0 ? this.buf.length : end;
      out += this.check(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
    return out;
  }

  get dropRatio(): number {
    return this.stats.numericSentences ? this.stats.dropped / this.stats.numericSentences : 0;
  }
}

/** Non-streaming convenience: verify a complete answer. */
export function sanitizeAnswer(text: string, ledger: FactLedger): { text: string; stats: GateStats; dropRatio: number } {
  const gate = new SentenceGate(ledger);
  const out = gate.push(text) + gate.flush();
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), stats: gate.stats, dropRatio: gate.dropRatio };
}
