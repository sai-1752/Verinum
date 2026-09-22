import { formatCompact, formatNumber, formatValue, type Unit } from "@verinum/core";

export { formatCompact, formatNumber, formatValue };
export type { Unit };

export const fmtBytes = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
export const fmtLimit = (n: number, fmt: (v: number) => string = formatNumber) => (n < 0 ? "Unlimited" : fmt(n));

const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });
const DATETIME = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const fmtDate = (iso: string | null | undefined) => (iso ? DATE.format(new Date(iso)) : "—");
export const fmtDateTime = (iso: string | null | undefined) => (iso ? DATETIME.format(new Date(iso)) : "—");

export function fmtRelative(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`;
  return fmtDate(iso);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
export const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Formats an axis/tooltip value for a chart in the chart's own unit. */
export function fmtChart(v: number | null | undefined, unit: Unit, currency?: string | null, o: { compact?: boolean; decimals?: number } = {}): string {
  if (v === null || v === undefined) return "—";
  return formatValue(v, unit, { currency, compact: o.compact, decimals: o.decimals });
}
