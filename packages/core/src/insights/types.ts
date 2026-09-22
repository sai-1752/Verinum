import type { ChartSpec } from "../charts";
import type { Fact } from "../facts";

export type InsightKind =
  | "leader" | "concentration" | "trend" | "period_change" | "anomaly" | "seasonality"
  | "profitability" | "loss_makers" | "margin_trend" | "volume_margin" | "correlation"
  | "customers" | "forecast" | "quality";

export type InsightCategory = "performance" | "trend" | "profitability" | "relationship" | "customers" | "forecast" | "quality";

/** Each factor is 0…1. The score is a fixed weighted sum, shown to users (spec §14). */
export interface RankFactors {
  /** how large is the effect, in practical terms */
  magnitude: number;
  /** how close is it to what the business cares about (lead metric, revenue, profit, customers) */
  relevance: number;
  /** statistical support (p-value, robust z, gate margin) */
  significance: number;
  /** penalty for repeating a finding of the same kind on the same subject */
  novelty: number;
  /** data sufficiency: sample size, backtest error, partial periods */
  confidence: number;
  /** how complete the underlying columns are */
  completeness: number;
}

export const RANK_WEIGHTS: Record<keyof RankFactors, number> = {
  magnitude: 0.3, relevance: 0.2, significance: 0.2, novelty: 0.1, confidence: 0.1, completeness: 0.1,
};

export interface InsightEvidence {
  /** the tool name that reproduces the numbers (same registry the AI uses) */
  tool: string;
  params: Record<string, unknown>;
}

export interface Insight {
  /** deterministic: same data ⇒ same id, so dismissals and comparisons survive re-computation */
  id: string;
  kind: InsightKind;
  category: InsightCategory;
  title: string;
  summary: string;
  detail: string[];
  facts: Fact[];
  columns: string[];
  /** 0–100 */
  score: number;
  priority: "high" | "medium" | "low";
  factors: RankFactors;
  confidence: "high" | "medium" | "low";
  caveats: string[];
  /** how it was computed, in one or two sentences */
  method: string;
  evidence: InsightEvidence;
  /** suggested questions for the AI analyst */
  followUps: string[];
  chart?: ChartSpec;
}

/** A candidate before ranking. */
export type Candidate = Omit<Insight, "score" | "priority"> & { subject: string };

export interface ExecutiveSummary {
  headline: string;
  bullets: { insightId: string | null; text: string }[];
  caveats: string[];
  facts: Fact[];
}

export interface InsightReport {
  version: string;
  rowsAnalysed: number;
  insights: Insight[];
  suppressed: { belowThreshold: number; duplicatesOfKind: number };
  summary: ExecutiveSummary;
}
