/**
 * Timezone-independent calendar arithmetic.
 *
 * Dates in Verinum are *civil dates*: a (year, month, day) triple stored as an
 * integer count of days since 1970-01-01. The JavaScript `Date` object is never used
 * for bucketing, so results cannot depend on the server's timezone. This removes the
 * class of "phantom period" bugs where a date-only ISO string parsed as UTC lands on
 * the previous local day (see docs/PARITY.md, safeguards 1-2).
 */

export type Grain = "day" | "week" | "month" | "quarter" | "year";
export const GRAINS: readonly Grain[] = ["day", "week", "month", "quarter", "year"];

export interface Civil {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

/** Days since 1970-01-01 for a proleptic-Gregorian civil date (Hinnant's algorithm). */
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): Civil {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

export function isValidCivil(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** ISO weekday index, Monday = 0 … Sunday = 6. 1970-01-01 was a Thursday. */
export function isoWeekday(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
}

const p2 = (v: number) => String(v).padStart(2, "0");

export function formatIsoDate(days: number): string {
  const { y, m, d } = civilFromDays(days);
  return `${String(y).padStart(4, "0")}-${p2(m)}-${p2(d)}`;
}

export function parseIsoDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1]!, mo = +m[2]!, d = +m[3]!;
  return isValidCivil(y, mo, d) ? daysFromCivil(y, mo, d) : null;
}

/* ------------------------------ period ordinals ----------------------------- */
// An ordinal is a gap-free integer index of a period within its grain, so consecutive
// periods differ by exactly 1 and missing periods are detectable.

export function periodOrdinal(days: number, grain: Grain): number {
  switch (grain) {
    case "day": return days;
    case "week": return Math.floor((days + 3) / 7);
    case "month": { const c = civilFromDays(days); return c.y * 12 + (c.m - 1); }
    case "quarter": { const c = civilFromDays(days); return c.y * 4 + Math.floor((c.m - 1) / 3); }
    case "year": return civilFromDays(days).y;
  }
}

export function periodStartDays(ord: number, grain: Grain): number {
  switch (grain) {
    case "day": return ord;
    case "week": return ord * 7 - 3;
    case "month": return daysFromCivil(Math.floor(ord / 12), (ord % 12) + 1, 1);
    case "quarter": return daysFromCivil(Math.floor(ord / 4), (ord % 4) * 3 + 1, 1);
    case "year": return daysFromCivil(ord, 1, 1);
  }
}

/** Inclusive last day of the period. */
export function periodEndDays(ord: number, grain: Grain): number {
  return periodStartDays(ord + 1, grain) - 1;
}

export function periodLengthDays(ord: number, grain: Grain): number {
  return periodStartDays(ord + 1, grain) - periodStartDays(ord, grain);
}

export function periodKey(ord: number, grain: Grain): string {
  switch (grain) {
    case "day":
    case "week": return formatIsoDate(periodStartDays(ord, grain));
    case "month": return `${Math.floor(ord / 12)}-${p2((ord % 12) + 1)}`;
    case "quarter": return `${Math.floor(ord / 4)}-Q${(ord % 4) + 1}`;
    case "year": return String(ord);
  }
}

export function ordinalFromKey(key: string, grain: Grain): number | null {
  switch (grain) {
    case "day": { const d = parseIsoDate(key); return d === null ? null : d; }
    case "week": { const d = parseIsoDate(key); return d === null ? null : periodOrdinal(d, "week"); }
    case "month": {
      const m = /^(\d{4})-(\d{2})$/.exec(key);
      return m && +m[2]! >= 1 && +m[2]! <= 12 ? +m[1]! * 12 + (+m[2]! - 1) : null;
    }
    case "quarter": {
      const m = /^(\d{4})-Q([1-4])$/.exec(key);
      return m ? +m[1]! * 4 + (+m[2]! - 1) : null;
    }
    case "year": return /^\d{4}$/.test(key) ? +key : null;
  }
}

export function periodLabel(ord: number, grain: Grain): string {
  if (grain === "month") return `${MONTH_SHORT[ord % 12]} ${Math.floor(ord / 12)}`;
  return periodKey(ord, grain);
}

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Chooses a sensible default grain from the span of the data (ported from the prototype). */
export function pickGrain(spanDays: number | null | undefined): Grain {
  if (spanDays == null || !isFinite(spanDays)) return "month";
  if (spanDays <= 45) return "day";
  if (spanDays <= 200) return "week";
  if (spanDays <= 1200) return "month";
  return "quarter";
}

/** Number of periods per seasonal cycle for a grain (0 = no natural cycle used). */
export function seasonLength(grain: Grain): number {
  return { day: 7, week: 52, month: 12, quarter: 4, year: 0 }[grain];
}

export function grainNoun(grain: Grain, plural = false): string {
  return plural ? `${grain}s` : grain;
}
