/**
 * Shared, JSON-serialisable types for profiles, capabilities and quality. These cross the
 * API boundary (stored in Postgres JSONB and rendered by the web app), so they contain no
 * typed arrays, Maps or class instances.
 */
import type { Grain } from "./time";
import type { HistBin, NumStats } from "./stats";
import type { Relation } from "./analytics/correlation";

export const ANALYSIS_VERSION = "1.0.0";

export type ColumnType = "numeric" | "categorical" | "date" | "datetime" | "boolean" | "text" | "identifier";
export type SemanticRole = "measure" | "dimension" | "time" | "identifier" | "text" | "boolean";

/** What a column *means* in business terms (evidence: name tokens + statistics + arithmetic relations). */
export type BusinessMeaning =
  | "revenue" | "profit" | "margin" | "cost" | "marketing" | "discount" | "price" | "quantity"
  | "customer" | "product" | "region" | "channel" | "segment" | "stage";

export type Subtype = "currency" | "percentage" | "geographic" | "calendar_part" | "coordinate" | "entity" | "email" | "url" | "code";

export interface TopValue { value: string; count: number; pct: number }

export interface DateInfo {
  minDay: number;
  maxDay: number;
  minIso: string;
  maxIso: string;
  spanDays: number;
  hasTime: boolean;
  kind: "event" | "attribute" | "unknown";
  /** ranking score used to choose the primary event date */
  score: number;
  /** distinct periods at the natural grain, and rows per period */
  periodCount: number;
  density: number;
  distinctDays: number;
}

export interface ColumnProfile {
  name: string;
  index: number;
  physical: "number" | "date" | "string" | "boolean";
  type: ColumnType;
  role: SemanticRole;
  meaning: BusinessMeaning | null;
  subtypes: Subtype[];
  /** confidence in `type` (0-1) */
  confidence: number;
  /** confidence in `meaning` (0-1) */
  meaningConfidence: number;
  /** evidence behind the classification, shown in the UI ("why was this classified as…") */
  reasons: string[];

  count: number;
  missing: number;
  missingPct: number;
  distinct: number;
  distinctPct: number;

  // numeric
  stats?: NumStats;
  histogram?: HistBin[];
  isInteger?: boolean;
  /** true when summing the column is meaningful */
  additive?: boolean;
  defaultAgg?: "sum" | "avg";
  unit?: "currency" | "percent" | "count" | "number";
  currency?: string | null;

  // date
  date?: DateInfo;

  // string / categorical
  top?: TopValue[];
  avgLength?: number;
  avgWords?: number;
  /** share of values that share the most common character-shape (e.g. AAA-9999) */
  formatUniformity?: number;

  /** usable as a chart/comparison dimension (bounded, non-unique cardinality) */
  chartDimension: boolean;
  /** can be grouped by (rankings, top-N) even when cardinality is high */
  groupable: boolean;
  /** excluded from automatic insights (ids, coordinates, calendar parts…) */
  analyzable: boolean;
}

export interface QualityIssue {
  id: string;
  severity: "high" | "medium" | "low";
  kind:
    | "missing_values" | "outliers" | "implausible_values" | "inconsistent_labels" | "duplicate_rows"
    | "invalid_values" | "mixed_types" | "ambiguous_dates" | "empty_column" | "constant_column"
    | "high_cardinality_text" | "future_dates";
  column?: string;
  detail: string;
  /** what the platform does about it / what the user could do */
  fix: string;
  affected: number;
}

export interface QualityReport {
  score: number;
  label: "Excellent" | "Good" | "Fair" | "Needs attention";
  completeness: number;
  issues: QualityIssue[];
  counts: { high: number; medium: number; low: number };
}

export interface CalendarInfo {
  dateColumn: string;
  grain: Grain;
  minDay: number;
  maxDay: number;
  minIso: string;
  maxIso: string;
  periods: number;
  completePeriods: number;
  trimmedStart: number;
  trimmedEnd: number;
  missingPeriods: number;
  firstCompleteKey: string | null;
  lastCompleteKey: string | null;
  notes: string[];
}

export interface Capabilities {
  hasData: boolean;
  measures: string[];
  additiveMeasures: string[];
  /** the metric used for headline analysis */
  leadMetric: string | null;
  /** chart-friendly dimensions (bounded cardinality) */
  dimensions: string[];
  /** every column that can be grouped by */
  groupable: string[];
  eventDate: string | null;
  grain: Grain | null;
  timeSeries: boolean;
  seasonality: boolean;
  forecast: boolean;
  revenue: string | null;
  profit: string | null;
  cost: string | null;
  marketing: string | null;
  discount: string | null;
  quantity: string | null;
  price: string | null;
  margin: boolean;
  customer: string | null;
  product: string | null;
  region: string | null;
  channel: string | null;
  segment: string | null;
  stage: string | null;
  cohort: boolean;
  correlation: boolean;
  outliers: boolean;
  /** why a capability is unavailable, keyed by capability name (shown to users; also fed to the LLM) */
  unavailable: Record<string, string>;
}

export interface DatasetProfile {
  version: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnProfile[];
  duplicateRows: number;
  duplicatePct: number;
  missingCells: number;
  missingPct: number;
  primaryDate: string | null;
  calendar: CalendarInfo | null;
  domain: string[];
  relations: Relation[];
  currency: string | null;
  quality: QualityReport;
  capabilities: Capabilities;
}

/** Looks a column up by name; profiles are small so a linear scan is fine. */
export function columnOf(p: DatasetProfile, name: string): ColumnProfile | undefined {
  return p.columns.find((c) => c.name === name);
}
