/**
 * Cell-level value parsers: numbers (US / European / Indian grouping, currency,
 * percent, accounting negatives), dates (per-column day/month order detection) and
 * booleans. All parsers are pure and locale-independent.
 */
import { daysFromCivil, isValidCivil } from "./time";

/* ---------------------------------- nulls ---------------------------------- */

export const NULL_TOKENS: ReadonlySet<string> = new Set([
  "", "na", "n/a", "n.a.", "null", "none", "nan", "-", "--", "?", "undefined", "nil",
  "#n/a", "#na", "#null!", "#value!", "#div/0!", "#ref!", "#name?", "#num!",
]);

export function isNullToken(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number") return Number.isNaN(v);
  return NULL_TOKENS.has(String(v).trim().toLowerCase());
}

/* --------------------------------- numbers --------------------------------- */

const CURRENCY_SYMBOLS = "$€£¥₹₩₽₺₫฿₦₴₪";
const CURRENCY_CODES = ["USD", "EUR", "GBP", "INR", "JPY", "CNY", "AUD", "CAD", "CHF", "SGD", "AED", "BRL", "MXN", "ZAR", "RS.", "RS", "INR."];
const SYMBOL_TO_CODE: Record<string, string> = {
  "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "₽": "RUB", "₺": "TRY", "₫": "VND", "฿": "THB", "₦": "NGN", "₴": "UAH", "₪": "ILS",
};

export interface NumberParse {
  value: number;
  /** ISO-ish currency code when a symbol/code was present. */
  currency?: string;
  percent?: boolean;
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const US_GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const INDIAN_GROUPED = /^\d{1,2}(,\d{2})+,\d{3}(\.\d+)?$/;
const EU_GROUPED = /^\d{1,3}(\.\d{3})+(,\d+)?$/;
const EU_PLAIN_DECIMAL = /^\d+,\d+$/;
const APOSTROPHE_GROUPED = /^\d{1,3}('\d{3})+(\.\d+)?$/;
const SPACE_GROUPED = /^\d{1,3}([\s  ]\d{3})+([.,]\d+)?$/;

/** Strips currency symbols/codes, returning the remaining string and the detected currency. */
function stripCurrency(s: string): { s: string; currency?: string } {
  let currency: string | undefined;
  let out = s;
  for (const ch of CURRENCY_SYMBOLS) {
    if (out.includes(ch)) { currency = SYMBOL_TO_CODE[ch]; out = out.split(ch).join(""); }
  }
  const upper = out.toUpperCase();
  for (const code of CURRENCY_CODES) {
    if (upper.startsWith(code) || upper.endsWith(code)) {
      const len = code.length;
      out = upper.startsWith(code) ? out.slice(len) : out.slice(0, out.length - len);
      currency = currency ?? (code.startsWith("RS") || code.startsWith("INR") ? "INR" : code);
      break;
    }
  }
  return { s: out.trim(), currency };
}

/**
 * Parses a numeric cell. `locale` controls how a lone comma/dot is read:
 * "us" → 1,234.56 ; "eu" → 1.234,56. Indian lakh grouping (12,34,567) is accepted in both.
 */
export function parseNumberCell(raw: unknown, locale: "us" | "eu" = "us"): NumberParse | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : null;
  if (typeof raw === "boolean" || raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || s.length > 40) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (s.endsWith("-") && !s.startsWith("-")) { negative = !negative; s = s.slice(0, -1).trim(); }
  const cur = stripCurrency(s);
  s = cur.s;
  let percent = false;
  if (s.endsWith("%")) { percent = true; s = s.slice(0, -1).trim(); }
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith("−")) { negative = !negative; s = s.slice(1).trim(); }
  if (!s || !/^\d|^\.\d/.test(s)) return null;

  let normalized: string | null = null;
  if (PLAIN_NUMBER.test(s) && (locale === "us" || !/^\d+\.\d{3}$/.test(s))) {
    normalized = s;
  } else if (US_GROUPED.test(s) || INDIAN_GROUPED.test(s)) {
    // "1,234" is ambiguous for eu locale (1,234 = 1.234); treat as decimal only when eu evidence exists.
    normalized = locale === "eu" && /^\d{1,3},\d{3}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (locale === "eu" && EU_GROUPED.test(s)) {
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (locale === "eu" && EU_PLAIN_DECIMAL.test(s)) {
    normalized = s.replace(",", ".");
  } else if (locale === "us" && EU_GROUPED.test(s) && s.includes(",")) {
    normalized = null; // "1.234,50" in a US-locale column: leave unparsed rather than guess
  } else if (APOSTROPHE_GROUPED.test(s)) {
    normalized = s.replace(/'/g, "");
  } else if (SPACE_GROUPED.test(s)) {
    normalized = s.replace(/[\s  ]/g, "").replace(",", ".");
  }
  if (normalized === null || !PLAIN_NUMBER.test(normalized)) return null;
  let value = parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  if (percent) value /= 100;
  if (negative) value = -value;
  const out: NumberParse = { value };
  if (cur.currency) out.currency = cur.currency;
  if (percent) out.percent = true;
  return out;
}

/**
 * Decides whether a column of numeric strings uses "1.234,56" (eu) or "1,234.56" (us)
 * conventions. Ambiguous values ("1.234", "1,234") carry no evidence either way.
 */
export function detectDecimalLocale(samples: string[]): "us" | "eu" {
  let eu = 0, us = 0;
  for (const raw of samples) {
    const t = stripCurrency(String(raw).trim()).s.replace(/^[+\-−(]+|[)%\-]+$/g, "").trim();
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(t)) eu++;
    else if (/^\d+,\d{1,2}$/.test(t)) eu++;
    else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t)) us++;
    else if (/^\d+\.\d+$/.test(t) && !/^\d{1,3}\.\d{3}$/.test(t)) us++;
    else if (/^\d{1,3}(,\d{3}){2,}$/.test(t)) us++;
  }
  return eu > us ? "eu" : "us";
}

/* ---------------------------------- dates ---------------------------------- */

export type DateOrder = "dmy" | "mdy";

export interface DateParse {
  days: number;
  hasTime: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const monthOf = (name: string): number | null => MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? null;
const year4 = (y: number): number => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

const TIME = String.raw`(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(?:[AaPp][Mm])?\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT)?)?`;
const RE_ISO = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}$`);
const RE_NUM_Y4 = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})${TIME}$`);
const RE_NUM_Y2 = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/;
const RE_D_MON_Y = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s,-]+(\d{2}|\d{4})$/;
const RE_MON_D_Y = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/;
const RE_MON_Y = /^([A-Za-z]{3,9})\.?[\s-]+(\d{4})$/;
const RE_YM = /^(\d{4})[-/](\d{1,2})$/;
const RE_YQ = /^(\d{4})[-\s]?Q([1-4])$/i;
const RE_QY = /^Q([1-4])[-\s]?(\d{4})$/i;

/** Quick structural check, used by type inference before committing to an order. */
function numericDateParts(s: string): { a: number; b: number; y: number; hasTime: boolean } | null {
  let m = RE_NUM_Y4.exec(s);
  if (m) return { a: +m[1]!, b: +m[2]!, y: +m[3]!, hasTime: m[4] !== undefined };
  m = RE_NUM_Y2.exec(s);
  if (m) return { a: +m[1]!, b: +m[2]!, y: year4(+m[3]!), hasTime: false };
  return null;
}

export function parseDateCell(raw: unknown, order: DateOrder = "mdy"): DateParse | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 40) return null;
  let m: RegExpExecArray | null;

  if ((m = RE_ISO.exec(s))) {
    const y = +m[1]!, mo = +m[2]!, d = +m[3]!;
    return isValidCivil(y, mo, d) ? { days: daysFromCivil(y, mo, d), hasTime: m[4] !== undefined } : null;
  }
  const np = numericDateParts(s);
  if (np) {
    const [mo, d] = order === "dmy" ? [np.b, np.a] : [np.a, np.b];
    return isValidCivil(np.y, mo, d) ? { days: daysFromCivil(np.y, mo, d), hasTime: np.hasTime } : null;
  }
  if ((m = RE_D_MON_Y.exec(s))) {
    const mo = monthOf(m[2]!);
    const y = year4(+m[3]!);
    return mo && isValidCivil(y, mo, +m[1]!) ? { days: daysFromCivil(y, mo, +m[1]!), hasTime: false } : null;
  }
  if ((m = RE_MON_D_Y.exec(s))) {
    const mo = monthOf(m[1]!);
    return mo && isValidCivil(+m[3]!, mo, +m[2]!) ? { days: daysFromCivil(+m[3]!, mo, +m[2]!), hasTime: false } : null;
  }
  if ((m = RE_MON_Y.exec(s))) {
    const mo = monthOf(m[1]!);
    return mo ? { days: daysFromCivil(+m[2]!, mo, 1), hasTime: false } : null;
  }
  if ((m = RE_YM.exec(s))) {
    const y = +m[1]!, mo = +m[2]!;
    return mo >= 1 && mo <= 12 && y >= 1900 ? { days: daysFromCivil(y, mo, 1), hasTime: false } : null;
  }
  if ((m = RE_YQ.exec(s))) return { days: daysFromCivil(+m[1]!, (+m[2]! - 1) * 3 + 1, 1), hasTime: false };
  if ((m = RE_QY.exec(s))) return { days: daysFromCivil(+m[2]!, (+m[1]! - 1) * 3 + 1, 1), hasTime: false };
  return null;
}

export interface DateOrderDetection {
  order: DateOrder;
  /** True when every numeric date was consistent with both orders (e.g. 05/03/2025). */
  ambiguous: boolean;
  evidence: { dmy: number; mdy: number };
}

/**
 * Decides day-first vs month-first for a whole column. A single value such as 13/01/2025
 * proves day-first for the column; the prototype decided per-cell, which silently mixed orders.
 */
export function detectDateOrder(samples: string[]): DateOrderDetection {
  let dmy = 0, mdy = 0, numeric = 0;
  for (const s of samples) {
    const p = numericDateParts(String(s).trim());
    if (!p) continue;
    numeric++;
    if (p.a > 12 && p.b <= 12) dmy++;
    else if (p.b > 12 && p.a <= 12) mdy++;
  }
  if (!numeric) return { order: "mdy", ambiguous: false, evidence: { dmy, mdy } };
  if (dmy > mdy) return { order: "dmy", ambiguous: false, evidence: { dmy, mdy } };
  if (mdy > dmy) return { order: "mdy", ambiguous: false, evidence: { dmy, mdy } };
  return { order: "mdy", ambiguous: true, evidence: { dmy, mdy } };
}

/* --------------------------------- booleans -------------------------------- */

const TRUE_TOKENS = new Set(["true", "t", "yes", "y"]);
const FALSE_TOKENS = new Set(["false", "f", "no", "n"]);

/** Returns 1/0 for explicit boolean tokens, null otherwise. Bare 0/1 are NOT treated as booleans here. */
export function parseBoolToken(raw: unknown): 0 | 1 | null {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const s = String(raw ?? "").trim().toLowerCase();
  if (TRUE_TOKENS.has(s)) return 1;
  if (FALSE_TOKENS.has(s)) return 0;
  return null;
}
