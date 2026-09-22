/**
 * Numeric-claim extraction. Finds every number an answer asserts — while ignoring numbers that
 * are labels rather than claims: dates and periods, years, identifiers ("ORD-100123", "Q4"),
 * list numbering, ordinals, times, and the digits inside known entity or column names.
 *
 * Precision is captured with each claim so verification is rounding-aware: "3.2M" is a claim
 * about the nearest 0.1M, so 3,225,540 supports it and 3,290,000 does not.
 */

export interface NumericClaim {
  /** the text as written */
  raw: string;
  start: number;
  end: number;
  /** absolute value with K/M/B/T applied */
  value: number;
  negative: boolean;
  kind: "percent" | "currency" | "ratio" | "plain" | "word";
  symbol?: string;
  /** decimals shown in the mantissa */
  decimals: number;
  /** half-unit of the last shown digit, in the claim's own units (multiplier applied) */
  tolerance: number;
  multiplier: number;
  /** a "about/around/roughly/~" hedge widens tolerance */
  hedged: boolean;
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const SYMBOLS = ["A$", "C$", "S$", "R$", "MX$", "$", "€", "£", "₹", "¥", "₩", "₽", "₺", "₫", "฿", "₦", "₴", "₪"];
const SYMBOL_RE = SYMBOLS.map((s) => s.replace(/[$]/g, "\\$")).join("|");

const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const WORD_RE = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})\\b(?=\\s+(?!of\\b|or\\b|and\\b|to\\b|in\\b|at\\b|on\\b|for\\b|the\\b|a\\b|is\\b|are\\b|was\\b|were\\b)[a-z])`, "gi");

const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};

/** Replaces `re` matches with same-length filler so offsets are preserved. */
function mask(text: string, re: RegExp): string {
  return text.replace(re, (m) => "\u0000".repeat(m.length));
}

function maskLabels(text: string, labels: Iterable<string>): string {
  const list = [...labels].filter((l) => l && l.length >= 2 && /[0-9]/.test(l)).sort((a, b) => b.length - a.length);
  let out = text;
  for (const l of list) {
    const re = new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, (m) => "\u0000".repeat(m.length));
  }
  return out;
}

export interface ExtractOptions {
  /** entity values / column names whose digits are part of a name, not a claim */
  labels?: Iterable<string>;
  spelledNumbers?: boolean;
}

export function extractNumericClaims(text: string, o: ExtractOptions = {}): NumericClaim[] {
  let t = text;
  t = maskLabels(t, o.labels ?? []);
  // code fences and inline code are examples, not claims
  t = mask(t, /```[\s\S]*?```/g);
  t = mask(t, /`[^`\n]*`/g);
  // URLs / emails
  t = mask(t, /\bhttps?:\/\/\S+/g);
  t = mask(t, /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g);
  // dates and periods: 2026-08-30, 2026-08, 2026-Q3, Q3 2026, FY2026, "March 3, 2026", "3 March 2026"
  t = mask(t, /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g);
  t = mask(t, /\b\d{4}-\d{2}\b/g);
  t = mask(t, /\b\d{4}-?W\d{2}\b/gi);
  t = mask(t, /\b\d{4}[- ]?Q[1-4]\b/gi);
  t = mask(t, /\bQ[1-4][ -]?\d{4}\b/gi);
  t = mask(t, /\bFY\s?\d{2,4}\b/gi);
  t = mask(t, new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"));
  t = mask(t, new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?(?:,?\\s+\\d{4})?\\b`, "gi"));
  t = mask(t, new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{4}\\b`, "gi"));
  // times of day
  t = mask(t, /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi);
  // bare years (1900–2100) that are not comma-grouped, decimals or followed by a unit noun
  t = t.replace(/(?<![\d.,$€£₹¥%-])\b(?:19|20)\d{2}\b(?![.,]\d)(?!\s*(?:units|rows|orders|customers|items|records|transactions|products|users|sales|%))/gi, (m) => "\u0000".repeat(m.length));
  // identifiers: letters directly followed by digits (Q4, H2, B2B, SKU123, ORD-100123, v1.2.3)
  t = mask(t, /\b[A-Za-z]{1,}[-_]?\d[\w.-]*/g);
  // ordinals and #n
  t = mask(t, /\b\d+(?:st|nd|rd|th)\b/gi);
  t = mask(t, /#\d+/g);
  // list markers at line starts: "1. ", "2) ", "(3) "
  t = t.replace(/^[ \t]*(?:\(?\d{1,3}[.)])\s+/gm, (m) => "\u0000".repeat(m.length));
  // table separators like |---|:--|
  t = mask(t, /^\s*\|?[\s:|-]{3,}\|?\s*$/gm);

  const claims: NumericClaim[] = [];
  const num = new RegExp(
    `(?<![\\w.,])(?<neg>[-−–]|\\()?\\s?(?<sym>${SYMBOL_RE})?\\s?(?<neg2>[-−–])?(?<int>\\d{1,3}(?:,\\d{3})+|\\d+)(?<frac>\\.\\d+)?(?:\\s?(?<suf>%|percent\\b|pct\\b|[KkMmBbTt]{1,2}(?![A-Za-z])|thousand\\b|million\\b|billion\\b|trillion\\b|[x×](?![A-Za-z])))?`,
    "gu",
  );
  let m: RegExpExecArray | null;
  while ((m = num.exec(t)) !== null) {
    const g = m.groups!;
    // "-" between digits is a range/hyphen, not a minus: require whitespace/start before a leading minus
    let neg = !!(g.neg && g.neg !== "(") || !!g.neg2;
    if ((g.neg === "-" || g.neg === "−" || g.neg === "–") && m.index > 0) {
      const prev = t[m.index - 1]!;
      if (/[\w.)]/.test(prev)) neg = !!g.neg2;
    }
    const acct = g.neg === "(" ? /^\)/.test(t.slice(m.index + m[0].length)) : false;
    const intStr = g.int!.replace(/,/g, "");
    const fracStr = g.frac ? g.frac.slice(1) : "";
    const mantissa = Number(`${intStr}${fracStr ? "." + fracStr : ""}`);
    if (!Number.isFinite(mantissa)) continue;
    let suf = (g.suf ?? "").toLowerCase();
    let kind: NumericClaim["kind"] = "plain";
    let multiplier = 1;
    if (suf === "%" || suf === "percent" || suf === "pct") kind = "percent";
    else if (suf === "x" || suf === "×") kind = "ratio";
    else if (suf && MULT[suf] !== undefined) multiplier = MULT[suf]!;
    else if (suf) suf = "";
    if (g.sym) kind = kind === "plain" ? "currency" : kind;
    // a bare number directly before a letter that is not a recognised suffix is part of a word/unit — keep it as a claim
    const start = m.index + (m[0].length - m[0].trimStart().length);
    const before = t.slice(Math.max(0, start - 14), start).toLowerCase();
    const hedged = /(?:about|around|roughly|approximately|approx\.?|nearly|almost|~|circa|over|under)\s*$/.test(before);
    const decimals = fracStr.length;
    const value = mantissa * multiplier;
    const end = m.index + m[0].length;
    claims.push({
      raw: text.slice(start, end).trim(), start, end, value, negative: neg || acct, kind, symbol: g.sym, decimals, multiplier,
      tolerance: 0.5 * Math.pow(10, -decimals) * multiplier * (hedged ? 2 : 1), hedged,
    });
  }

  if (o.spelledNumbers !== false) {
    let w: RegExpExecArray | null;
    WORD_RE.lastIndex = 0;
    while ((w = WORD_RE.exec(t)) !== null) {
      const v = WORD_NUMBERS[w[1]!.toLowerCase()]!;
      claims.push({ raw: w[0], start: w.index, end: w.index + w[0].length, value: v, negative: false, kind: "word", decimals: 0, multiplier: 1, tolerance: 0.5, hedged: false });
    }
  }
  return claims.sort((a, b) => a.start - b.start);
}
