/**
 * Data-quality report. Scoring follows the prototype's rubric so scores stay comparable, but every
 * deduction is backed by a concrete, explainable issue (spec §11).
 *
 *   score = 100 − min(30, missing% · 1.6) − min(20, duplicate% · 4) − min(35, Σ issue weights)
 *   weights: high 9, medium 4, low 1.2; floor 12
 */
import type { CleanResult } from "./clean";
import type { ColumnProfile, DatasetProfile, QualityIssue, QualityReport } from "./types";

const SEVERITY_WEIGHT = { high: 9, medium: 4, low: 1.2 } as const;
const NON_NEGATIVE_MEANINGS = new Set(["quantity", "price", "revenue"]);
const NON_NEGATIVE_NAME = /(^|[^a-z])(qty|quantity|units?|price|sales|revenue)([^a-z]|$)/i;

const pct = (v: number, d = 1) => `${v.toFixed(d)}%`;
const num = (v: number) => v.toLocaleString("en-US");

export interface QualityOptions {
  /** civil day "today"; when given, dates after it are flagged as future dates */
  todayDays?: number;
}

export function buildQualityReport(profile: DatasetProfile, clean?: CleanResult, opts: QualityOptions = {}): QualityReport {
  const issues: QualityIssue[] = [];
  const n = profile.rowCount;

  for (const c of profile.columns) {
    if (c.count === 0) {
      issues.push({
        id: `empty:${c.name}`, severity: "low", kind: "empty_column", column: c.name, affected: n,
        detail: `"${c.name}" has no values at all.`, fix: "Exclude the column from analysis (it carries no information).",
      });
      continue;
    }
    if (c.distinct <= 1 && c.count > 1 && c.role !== "time") {
      issues.push({
        id: `constant:${c.name}`, severity: "low", kind: "constant_column", column: c.name, affected: c.count,
        detail: `"${c.name}" contains a single value (${c.top?.[0]?.value ?? String(c.stats?.min ?? "")}) in every row.`,
        fix: "It cannot explain any variation, so it is left out of automatic insights.",
      });
    }
    if (c.missingPct > 2) {
      const severity = c.missingPct > 25 ? "high" : c.missingPct > 8 ? "medium" : "low";
      issues.push({
        id: `missing:${c.name}`, severity, kind: "missing_values", column: c.name, affected: c.missing,
        detail: `"${c.name}" is blank in ${num(c.missing)} rows (${pct(c.missingPct)}).`,
        fix: "Blank values are excluded from calculations on this column and shown as “(blank)” when grouping; they are never filled in silently.",
      });
    }
    if (c.type === "numeric" && c.analyzable && c.stats && c.stats.count >= 12 && c.stats.outlierPct > 1) {
      const sev = c.stats.outlierPct > 5 ? "medium" : "low";
      issues.push({
        id: `outliers:${c.name}`, severity: sev, kind: "outliers", column: c.name, affected: c.stats.outlierCount,
        detail: `"${c.name}" has ${num(c.stats.outlierCount)} values (${pct(c.stats.outlierPct)}) outside the 1.5 × IQR fences (${num(round2(c.stats.fenceLow))} to ${num(round2(c.stats.fenceHigh))}).`,
        fix: "Outliers are kept and reported; review them in the explorer before excluding anything.",
      });
    }
    if (c.type === "numeric" && c.stats && c.stats.negatives > 0 && (NON_NEGATIVE_MEANINGS.has(c.meaning ?? "") || NON_NEGATIVE_NAME.test(c.name)) && c.meaning !== "profit" && c.meaning !== "margin") {
      issues.push({
        id: `negative:${c.name}`, severity: "medium", kind: "implausible_values", column: c.name, affected: c.stats.negatives,
        detail: `"${c.name}" has ${num(c.stats.negatives)} negative values, which is unusual for a ${c.meaning ?? "quantity-like"} column (returns/refunds can be legitimate).`,
        fix: "Kept as-is and included in totals; confirm whether they are returns or entry errors.",
      });
    }
    if (c.type === "categorical" && c.count >= 20 && c.distinctPct > 50 && c.role === "dimension" && !c.chartDimension && c.physical === "string" && c.distinct > 200) {
      issues.push({
        id: `highcard:${c.name}`, severity: "low", kind: "high_cardinality_text", column: c.name, affected: c.distinct,
        detail: `"${c.name}" has ${num(c.distinct)} distinct values, so it works for rankings but not as a chart breakdown.`,
        fix: "Used for top-N questions only.",
      });
    }
    if (opts.todayDays !== undefined && c.date && c.role === "time" && c.date.kind !== "attribute" && c.date.maxDay > opts.todayDays) {
      issues.push({
        id: `future:${c.name}`, severity: "medium", kind: "future_dates", column: c.name, affected: 1,
        detail: `"${c.name}" contains dates after today (latest ${c.date.maxIso}).`,
        fix: "Future-dated rows can distort recent-period comparisons; check whether they are forecasts or typos.",
      });
    }
  }

  if (profile.duplicateRows > 0) {
    // duplicates inflate every total, so even a small share is worth a medium flag
    const sev = profile.duplicatePct > 5 ? "high" : profile.duplicatePct > 0.1 ? "medium" : "low";
    issues.push({
      id: "duplicates", severity: sev, kind: "duplicate_rows", affected: profile.duplicateRows,
      detail: `${num(profile.duplicateRows)} rows (${pct(profile.duplicatePct)}) repeat an earlier row exactly, across every column.`,
      fix: "Duplicates are flagged but kept. Review and remove them from the cleaning panel if they are not legitimate repeat transactions.",
    });
  }

  if (clean) {
    for (const info of clean.columns) {
      if (info.coercedCells > 0) {
        const share = info.present ? (info.coercedCells / info.present) * 100 : 0;
        issues.push({
          id: `invalid:${info.name}`, severity: share > 5 ? "medium" : "low", kind: "invalid_values", column: info.name, affected: info.coercedCells,
          detail: `${num(info.coercedCells)} value${info.coercedCells === 1 ? "" : "s"} in "${info.name}" could not be read as ${info.dateOrder ? "dates" : "numbers"} and became blank${info.coercedExamples.length ? ` (e.g. ${info.coercedExamples.slice(0, 3).map((e) => `“${e}”`).join(", ")})` : ""}.`,
          fix: "Shown in the transformation log with examples; the original file is untouched.",
        });
      }
      if (info.dateOrderAmbiguous) {
        issues.push({
          id: `ambdate:${info.name}`, severity: "medium", kind: "ambiguous_dates", column: info.name, affected: info.present,
          detail: `Dates in "${info.name}" could be day-first or month-first; ${info.dateOrder === "dmy" ? "day-first" : "month-first"} was assumed.`,
          fix: "Confirm the date order; a wrong guess would swap days and months.",
        });
      }
    }
    for (const s of clean.suggestions) {
      if (s.kind === "normalize_labels") {
        issues.push({
          id: `labels:${s.column ?? s.id}`, severity: "medium", kind: "inconsistent_labels", column: s.column, affected: s.affected,
          detail: s.detail, fix: s.proposedAction,
        });
      } else if (s.kind === "review_mixed_type") {
        issues.push({
          id: `mixed:${s.column ?? s.id}`, severity: "medium", kind: "mixed_types", column: s.column, affected: s.affected,
          detail: s.detail, fix: s.proposedAction,
        });
      }
    }
  }

  issues.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.affected - a.affected || (a.id < b.id ? -1 : 1));

  const weights = issues.reduce((a, i) => a + SEVERITY_WEIGHT[i.severity], 0);
  const raw = 100 - Math.min(30, profile.missingPct * 1.6) - Math.min(20, profile.duplicatePct * 4) - Math.min(35, weights);
  const score = Math.round(Math.max(12, Math.min(100, raw)));
  const label: QualityReport["label"] = score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Fair" : "Needs attention";
  const counts = { high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity]++;
  return { score, label, completeness: Math.max(0, 100 - profile.missingPct), issues, counts };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Exposed for the UI/insight engine: does the column have quality issues that should soften conclusions? */
export function columnIssues(q: QualityReport, column: string): QualityIssue[] {
  return q.issues.filter((i) => i.column === column);
}

export type { ColumnProfile };
