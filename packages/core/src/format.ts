/**
 * Deterministic number formatting. Never uses toLocaleString/Intl, so output is identical on
 * every server and never depends on a currency the data does not actually carry.
 */

export type Unit = "currency" | "percent" | "count" | "ratio" | "number" | "days" | "text" | "date";

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", CNY: "¥", KRW: "₩", RUB: "₽", TRY: "₺", VND: "₫",
  THB: "฿", NGN: "₦", UAH: "₴", ILS: "₪", AUD: "A$", CAD: "C$", CHF: "CHF ", SGD: "S$", AED: "AED ", BRL: "R$", MXN: "MX$", ZAR: "R",
};

export function currencySymbol(code: string | null | undefined): string {
  if (!code) return "";
  return CURRENCY_SYMBOL[code] ?? `${code} `;
}

/** 1234567.891 → "1,234,567.89" (decimals default: 0 for integers, else 2). */
export function formatNumber(v: number, decimals?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const d = decimals ?? (Number.isInteger(v) ? 0 : 2);
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(d);
  const [int, frac] = fixed.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = frac ? `${grouped}.${frac}` : grouped;
  return neg && Number(fixed) !== 0 ? `-${out}` : out;
}

/** 1834921 → "1.83M"; below 10k falls back to grouped digits. */
export function formatCompact(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(decimals)}T`;
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(decimals)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(decimals)}M`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return formatNumber(v);
}

export function formatPercent(pct: number, decimals = 1, signed = false): string {
  if (!Number.isFinite(pct)) return "—";
  const s = pct.toFixed(decimals);
  return `${signed && pct > 0 ? "+" : ""}${s}%`;
}

export interface FormatContext {
  currency?: string | null;
  compact?: boolean;
  decimals?: number;
}

export function formatValue(v: number | null | undefined, unit: Unit = "number", ctx: FormatContext = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "currency": {
      const sym = currencySymbol(ctx.currency);
      const body = ctx.compact === false ? formatNumber(Math.abs(v), ctx.decimals ?? 2) : formatCompact(Math.abs(v));
      return `${v < 0 ? "-" : ""}${sym}${body}`;
    }
    case "percent": return formatPercent(v, ctx.decimals ?? 1);
    case "ratio": return `${v.toFixed(ctx.decimals ?? 2)}×`;
    case "count": return formatNumber(Math.round(v), 0);
    case "days": return `${formatNumber(v, ctx.decimals ?? 1)} days`;
    case "number":
    default:
      return ctx.compact === false ? formatNumber(v, ctx.decimals) : formatCompactSmall(v);
  }
}

function formatCompactSmall(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e4) return formatCompact(v);
  if (Number.isInteger(v)) return formatNumber(v, 0);
  if (a < 1) return v.toFixed(3);
  return formatNumber(v, 2);
}
