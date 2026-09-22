/**
 * The dataset pipeline, as a pure function of (bytes, options) → analysis artifacts. It knows nothing
 * about databases or tenants, which is what makes it testable and re-runnable: reprocessing a file
 * with different cleaning choices is just another call.
 *
 * Stages (reported to the UI as a 7-step progress list):
 *   1 read → 2 extract → 3 clean → 4 profile → 5 quality → 6 insights → 7 dashboard
 */
import { gzipSync } from "node:zlib";
import {
  buildFrame, buildProfile, createContext, dropColumns, generateInsights, normalizeLabels, planDashboard, removeDuplicateRows,
  serializeFrame, daysFromCivil, ANALYSIS_VERSION,
  type CleanSuggestion, type DashboardPlan, type DatasetProfile, type Frame, type InsightReport, type Transformation,
} from "@verinum/core";
import { ingestFile, ingestInWorker, IngestError, type IngestLimits, type StructuredDocument } from "@verinum/ingest";
import type { ProcessOptions } from "./options";

export const STAGES = [
  { id: "read", label: "Reading the file" },
  { id: "extract", label: "Finding the data table" },
  { id: "clean", label: "Cleaning and typing columns" },
  { id: "profile", label: "Profiling columns" },
  { id: "quality", label: "Scoring data quality" },
  { id: "insights", label: "Generating insights" },
  { id: "dashboard", label: "Building the dashboard" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

export interface TableSummary { index: number; name: string; rows: number; columns: number; kind: string; sheet?: string; page?: number; notes: string[] }

export interface PipelineResult {
  format: string;
  formatReason: string;
  warnings: string[];
  availableTables: TableSummary[];
  tableIndex: number;
  tableName: string;
  frame: Frame;
  /** gzip of serializeFrame(frame) */
  frameBlob: Uint8Array;
  profile: DatasetProfile;
  transformations: Transformation[];
  suggestions: CleanSuggestion[];
  insights: InsightReport;
  plan: DashboardPlan;
  document: StructuredDocument | null;
  analysisVersion: string;
  timings: Record<string, number>;
}

export interface PipelineInput {
  bytes: Uint8Array;
  filename: string;
  options: ProcessOptions;
  limits?: Partial<IngestLimits>;
  /** run extraction in an isolated worker thread (always true in the service; tests may run inline) */
  isolate?: boolean;
  memoryMb?: number;
  today: Date;
  onStage?: (stage: StageId, index: number) => void | Promise<void>;
  signal?: AbortSignal;
}

/** Picks the table most likely to be "the data": the biggest by cells, preferring real rows and columns. */
export function pickTable(tables: { rows: unknown[]; columns: unknown[]; name: string }[]): number {
  let best = 0, bestScore = -1;
  tables.forEach((t, i) => {
    const score = t.rows.length * Math.min(t.columns.length, 30) - (t.name === "Document text" ? 1e12 : 0);
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const timings: Record<string, number> = {};
  let t = Date.now();
  const stage = async (s: StageId) => {
    input.signal?.throwIfAborted();
    const now = Date.now();
    timings.previous = now - t; t = now;
    await input.onStage?.(s, STAGES.findIndex((x) => x.id === s));
  };
  const lap = (k: string) => { const now = Date.now(); timings[k] = now - t; t = now; };

  await stage("read");
  await stage("extract");
  const ing = input.isolate === false
    ? await ingestFile(input.bytes, { filename: input.filename, limits: input.limits })
    : await ingestInWorker(input.bytes, { filename: input.filename, limits: input.limits, memoryMb: input.memoryMb });
  lap("extract");

  const availableTables: TableSummary[] = ing.tables.map((tb, i) => ({
    index: i, name: tb.name, rows: tb.rows.length, columns: tb.columns.length, kind: tb.source.kind, sheet: tb.source.sheet, page: tb.source.page, notes: tb.notes,
  }));
  const tableIndex = input.options.tableIndex ?? pickTable(ing.tables);
  const table = ing.tables[tableIndex];
  if (!table) throw new IngestError("no_tables", `Table ${tableIndex + 1} doesn't exist in this file.`);

  await stage("clean");
  const clean = buildFrame({ name: table.name, columns: table.columns, rows: table.rows }, { dateOrders: input.options.dateOrders });
  let frame = clean.frame;
  const transformations: Transformation[] = [...clean.log];
  const apply = (r: { frame: Frame; log: Transformation[] }) => { frame = r.frame; transformations.push(...r.log); };
  if (input.options.excludeColumns.length) apply(dropColumns(frame, input.options.excludeColumns));
  if (input.options.normalizeLabels) apply(normalizeLabels(frame));
  if (input.options.removeDuplicates) apply(removeDuplicateRows(frame));
  lap("clean");

  await stage("profile");
  const t0 = input.today;
  const todayDays = daysFromCivil(t0.getUTCFullYear(), t0.getUTCMonth() + 1, t0.getUTCDate());
  // Re-derive duplicate/label suggestions against what is left after the user's choices
  const profile = buildProfile(frame, frame === clean.frame ? clean : { ...clean, frame, duplicateRows: input.options.removeDuplicates ? 0 : clean.duplicateRows }, { todayDays });
  lap("profile");

  await stage("quality");
  const suggestions = clean.suggestions.filter((s) => {
    if (s.kind === "remove_duplicates") return !input.options.removeDuplicates;
    if (s.kind === "normalize_labels") return !input.options.normalizeLabels;
    if (s.kind === "confirm_date_order") return !(s.column && input.options.dateOrders[s.column]);
    if (s.kind === "drop_empty_column") return !(s.column && input.options.excludeColumns.includes(s.column));
    return true;
  });
  lap("quality");

  await stage("insights");
  const ctx = createContext(frame, profile);
  const insights = generateInsights(ctx);
  lap("insights");

  await stage("dashboard");
  const plan = planDashboard(ctx);
  lap("dashboard");

  const frameBlob = gzipSync(serializeFrame(frame), { level: 4 });
  return {
    format: ing.format, formatReason: ing.formatReason, warnings: ing.warnings, availableTables, tableIndex, tableName: table.name,
    frame, frameBlob, profile, transformations, suggestions, insights, plan, document: ing.document ?? null, analysisVersion: ANALYSIS_VERSION, timings,
  };
}
