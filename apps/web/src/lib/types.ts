/** Wire types. Analytical shapes come straight from the engine package (types only — no engine code ships to the browser). */
import type {
  ChartSpec, DashboardFilterSpec, DashboardView, DatasetProfile, Fact, Insight, InsightReport, Kpi, Provenance,
  QualityIssue, QualityReport, SourceRef, WidgetResult, WidgetSpec,
} from "@verinum/core";

export type { ChartSpec, DashboardFilterSpec, DashboardView, DatasetProfile, Fact, Insight, InsightReport, Kpi, Provenance, QualityIssue, QualityReport, SourceRef, WidgetResult, WidgetSpec };

export type Role = "owner" | "admin" | "analyst" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "analyst", "viewer"];

export interface User { id: string; email: string; name: string; emailVerified: boolean; isPlatformAdmin: boolean }
export interface WorkspaceSummary { id: string; name: string; slug: string; planId: string; role: Role; createdAt: string; permissions?: string[] }
export interface MeResponse { user: User; workspaces: WorkspaceSummary[] }

export interface PlanLimits { maxDatasets: number; maxUploadBytes: number; maxRowsPerDataset: number; maxMembers: number; aiMessagesPerMonth: number; exportsPerMonth: number; storageBytes: number }
export interface PlanFeatures { forecast: boolean; cohort: boolean; export: boolean; aiChat: boolean; rowExamples: boolean }
export interface PlanInfo { id: string; name: string; priceMonthlyUsd: number; limits: PlanLimits; features: PlanFeatures }
export interface AuthConfig { registration: boolean; requireEmailVerification: boolean; oauth: { google: boolean }; ai: { provider: string; model: string } | null; billing: boolean; plans: PlanInfo[] }

export interface WorkspaceDetail {
  id: string; name: string; slug: string; planId: string; settings: Record<string, unknown>; role: Role; permissions: string[];
  plan: { id: string; name: string; features: PlanFeatures; limits: PlanLimits };
}

export type DatasetStatus = "queued" | "processing" | "ready" | "failed" | "deleting";
export interface DatasetRow {
  id: string; name: string; status: DatasetStatus; isDemo: boolean; sourceName: string; sourceFormat: string; currentVersionId: string | null;
  error: string | null; createdAt: string; updatedAt: string; rowCount?: number | null; columnCount?: number | null; qualityScore?: number | null;
}
export interface Stage { id: string; label: string }
export interface AvailableTable { kind: string; name: string; rows: number; index: number; notes: string[]; columns: number }
export interface ProcessOptions { tableIndex?: number; removeDuplicates: boolean; normalizeLabels: boolean; dateOrders: Record<string, "dmy" | "mdy">; excludeColumns: string[] }
export interface VersionInfo {
  id: string; version: number; status: string; rowCount: number | null; columnCount: number | null; tableIndex: number; tableName: string | null;
  availableTables: AvailableTable[]; options: ProcessOptions; warnings: string[]; byteSize: number; analysisVersion: string; error: string | null; createdAt: string;
}
export interface JobProgress { pct: number; label: string; stage: string; stages: number; stageIndex: number }
export interface JobInfo { id: string; kind: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; attempts: number; progress: JobProgress | null; error: string | null; createdAt: string; finishedAt: string | null; stages: Stage[] }
export interface DatasetDetail extends Omit<DatasetRow, "rowCount" | "columnCount" | "qualityScore"> { version: VersionInfo | null; pending: VersionInfo | null; job: JobInfo | null }

export interface Transformation { id: string; kind: string; column?: string; detail: string; affected: number; severity: "info" | "notice" | "warning"; examples?: string[] }
export interface Suggestion { id: string; kind: string; detail: string; affected: number; proposedAction: string }
export interface QualityResponse { version: VersionInfo; quality: QualityReport; transformations: Transformation[]; suggestions: Suggestion[]; warnings: string[] }
export interface ProfileResponse { dataset: DatasetRow; version: VersionInfo; profile: DatasetProfile }
export interface InsightsResponse { version: VersionInfo; report: InsightReport }

export interface DashboardResponse { view: DashboardView; filters: DashboardFilterSpec[]; dataset: DatasetRow; version: VersionInfo }
export interface SavedDashboard { id: string; name: string; widgets: WidgetSpec[]; updatedAt: string }
export type FilterOp = "eq" | "neq" | "in" | "not_in" | "contains" | "gt" | "gte" | "lt" | "lte" | "between" | "is_null" | "not_null";
export interface Filter { column: string; op: FilterOp; value?: string | number | boolean | null; values?: (string | number | boolean)[] }

export interface ToolRunResponse { summary: string; facts: Fact[]; chart?: ChartSpec; provenance: Provenance; data: unknown }
export interface ToolInfo { name: string; description: string; input_schema: unknown }
export interface RowsResponse { columns: { name: string; kind: string }[]; rows: (string | number | boolean | null)[][]; matched: number; total: number; offset: number; appliedFilters: string[] }

export type ChatMode = "llm" | "deterministic" | "no_answer";
export interface GroundingPublic { sentences: number; numericSentences: number; dropped: number; dropRatio: number }
export interface ChatAnswer {
  conversationId: string; messageId: string; answer: string; mode: ChatMode; replaced: boolean; sources: SourceRef[]; charts: ChartSpec[];
  followUps: string[]; grounding: GroundingPublic; warnings: string[]; facts: Fact[]; provider: string | null; model: string | null;
}
export interface StoredMessage {
  id: string; role: "user" | "assistant"; content: string; mode: ChatMode | null; sources: SourceRef[] | null; charts: ChartSpec[] | null;
  grounding: GroundingPublic | null; warnings: string[] | null; followUps: string[] | null; feedback: number | null; createdAt: string;
}
export interface ConversationSummary { id: string; title: string; updatedAt: string; messages: number }
export interface Conversation { id: string; title: string; messages: StoredMessage[] }

export interface Member { userId: string; role: Role; joinedAt: string; email: string; name: string }
export interface Invitation { id: string; email: string; role: Role; createdAt: string; expiresAt: string }
export interface UsageMeter { used: number; limit: number }
export interface UsageSummary { plan: { id: string; name: string }; periodStart: string; datasets: UsageMeter; storageBytes: UsageMeter; members: UsageMeter; aiMessages: UsageMeter; exports: UsageMeter }
export interface AuditEvent { id: number; actor: { id: string; name: string; email: string } | null; action: string; targetType: string | null; targetId: string | null; meta: Record<string, unknown> | null; createdAt: string }
export interface BillingInfo { enabled: boolean; plan: { id: string; name: string }; subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null; hasCustomer: boolean }
export interface SessionInfo { id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean }
