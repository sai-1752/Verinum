import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, del, get, patch, post, put } from "./api";
import type {
  BillingInfo, Conversation, ConversationSummary, DashboardResponse, DatasetDetail, DatasetRow, Filter, InsightsResponse, Invitation,
  Member, ProfileResponse, QualityResponse, RowsResponse, SavedDashboard, Stage, ToolRunResponse, UsageSummary, AuditEvent, WidgetSpec, WorkspaceDetail,
} from "./types";
import type { DashboardFilterSpec, DatasetProfile } from "./types";

const ws = (w: string) => `/workspaces/${w}`;
const ds = (w: string, d: string) => `/workspaces/${w}/datasets/${d}`;
const IN_FLIGHT = new Set(["queued", "processing"]);

export const useWorkspaceDetail = (w: string) => useQuery({ queryKey: ["ws", w], queryFn: () => get<{ workspace: WorkspaceDetail }>(ws(w)).then((r) => r.workspace) });

export const useDatasets = (w: string) => useQuery({
  queryKey: ["datasets", w],
  queryFn: () => get<{ datasets: DatasetRow[]; stages: Stage[] }>(`${ws(w)}/datasets`),
  refetchInterval: (q) => (q.state.data?.datasets.some((d) => IN_FLIGHT.has(d.status) || d.status === "deleting") ? 1500 : false),
});

export const useDataset = (w: string, d: string) => useQuery({
  queryKey: ["dataset", w, d],
  queryFn: () => get<DatasetDetail>(ds(w, d)),
  refetchInterval: (q) => (q.state.data && (IN_FLIGHT.has(q.state.data.status) || q.state.data.pending) ? 1200 : false),
});

export const useProfile = (w: string, d: string, version?: string | null) => useQuery({ queryKey: ["profile", w, d, version], queryFn: () => get<ProfileResponse>(`${ds(w, d)}/profile`), enabled: !!version });
export const useQuality = (w: string, d: string, version?: string | null) => useQuery({ queryKey: ["quality", w, d, version], queryFn: () => get<QualityResponse>(`${ds(w, d)}/quality`), enabled: !!version });
export const useInsights = (w: string, d: string, version?: string | null) => useQuery({ queryKey: ["insights", w, d, version], queryFn: () => get<InsightsResponse>(`${ds(w, d)}/insights`), enabled: !!version });
export const useStarterQuestions = (w: string, d: string, version?: string | null) => useQuery({ queryKey: ["starters", w, d, version], queryFn: () => get<{ questions: string[] }>(`${ds(w, d)}/starter-questions`).then((r) => r.questions), enabled: !!version });

export function useDashboard(w: string, d: string, version: string | null | undefined, body: { filters: Filter[]; dateFrom?: string; dateTo?: string; widgets?: WidgetSpec[]; dashboardId?: string }) {
  return useQuery({
    queryKey: ["dashboard", w, d, version, body],
    queryFn: () => post<DashboardResponse>(`${ds(w, d)}/dashboard`, body),
    enabled: !!version, placeholderData: keepPreviousData, staleTime: 30_000,
  });
}
export const useSavedDashboards = (w: string, d: string) => useQuery({ queryKey: ["dashboards", w, d], queryFn: () => get<{ dashboards: SavedDashboard[] }>(`${ds(w, d)}/dashboards`).then((r) => r.dashboards) });

export const useColumns = (w: string, d: string, version?: string | null) => useQuery({
  queryKey: ["columns", w, d, version],
  queryFn: () => get<{ columns: DatasetProfile["columns"]; filters: DashboardFilterSpec[]; rowCount: number }>(`${ds(w, d)}/columns`),
  enabled: !!version,
});

export function useRows(w: string, d: string, version: string | null | undefined, body: { filters: Filter[]; search?: string; offset: number; limit: number; sort?: { column: string; dir: "asc" | "desc" } | null }) {
  return useQuery({ queryKey: ["rows", w, d, version, body], queryFn: () => post<RowsResponse>(`${ds(w, d)}/rows`, body), enabled: !!version, placeholderData: keepPreviousData });
}

export const useForecast = (w: string, d: string, version: string | null | undefined, params: Record<string, unknown>, enabled = true) => useQuery({
  queryKey: ["forecast", w, d, version, params],
  queryFn: () => post<ToolRunResponse>(`${ds(w, d)}/tools/run`, { tool: "forecast", params }),
  enabled: !!version && enabled, retry: false,
});

export const useUsage = (w: string, enabled = true) => useQuery({ queryKey: ["usage", w], queryFn: () => get<UsageSummary>(`${ws(w)}/usage`), enabled });
export const useMembers = (w: string) => useQuery({ queryKey: ["members", w], queryFn: () => get<{ members: Member[]; invitations: Invitation[] }>(`${ws(w)}/members`) });
export const useAudit = (w: string, enabled = true) => useQuery({ queryKey: ["audit", w], queryFn: () => get<{ events: AuditEvent[] }>(`${ws(w)}/audit`, { limit: 100 }).then((r) => r.events), enabled });
export const useBilling = (w: string, enabled = true) => useQuery({ queryKey: ["billing", w], queryFn: () => get<BillingInfo>(`${ws(w)}/billing`), enabled });

export const useConversations = (w: string, d: string) => useQuery({ queryKey: ["conversations", w, d], queryFn: () => get<{ conversations: ConversationSummary[] }>(`${ds(w, d)}/conversations`).then((r) => r.conversations) });
export const useConversation = (w: string, d: string, id: string | null) => useQuery({ queryKey: ["conversation", w, d, id], queryFn: () => get<Conversation>(`${ds(w, d)}/conversations/${id}`), enabled: !!id, gcTime: 0 });

/* ---- mutations ---- */
export function useDatasetMutations(w: string) {
  const qc = useQueryClient();
  const inv = (d?: string) => { void qc.invalidateQueries({ queryKey: ["datasets", w] }); void qc.invalidateQueries({ queryKey: ["usage", w] }); if (d) void qc.invalidateQueries({ queryKey: ["dataset", w, d] }); };
  return {
    upload: useMutation({
      mutationFn: (a: { file: File; name?: string }) => { const f = new FormData(); if (a.name) f.set("name", a.name); f.set("file", a.file); return api<{ datasetId: string; versionId: string; jobId: string }>(`${ws(w)}/datasets`, { method: "POST", form: f }); },
      onSuccess: () => inv(),
    }),
    demo: useMutation({ mutationFn: () => post<{ datasetId: string; versionId: string; jobId: string }>(`${ws(w)}/datasets/demo`), onSuccess: () => inv() }),
    rename: useMutation({ mutationFn: (a: { id: string; name: string }) => patch(`${ds(w, a.id)}`, { name: a.name }), onSuccess: (_r, a) => inv(a.id) }),
    remove: useMutation({ mutationFn: (id: string) => del(ds(w, id)), onSuccess: () => inv() }),
    reprocess: useMutation({ mutationFn: (a: { id: string; options: Record<string, unknown> }) => post(`${ds(w, a.id)}/reprocess`, { options: a.options }), onSuccess: (_r, a) => inv(a.id) }),
    cancelJob: useMutation({ mutationFn: (jobId: string) => post(`${ws(w)}/jobs/${jobId}/cancel`) }),
    activateVersion: useMutation({ mutationFn: (a: { id: string; versionId: string }) => post(`${ds(w, a.id)}/versions/${a.versionId}/activate`), onSuccess: (_r, a) => { inv(a.id); void qc.invalidateQueries(); } }),
  };
}

export function useDashboardMutations(w: string, d: string) {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["dashboards", w, d] });
  return {
    save: useMutation({ mutationFn: (a: { name: string; widgets: WidgetSpec[] }) => post<{ id: string }>(`${ds(w, d)}/dashboards`, a), onSuccess: inv }),
    update: useMutation({ mutationFn: (a: { id: string; name: string; widgets: WidgetSpec[] }) => put(`${ds(w, d)}/dashboards/${a.id}`, { name: a.name, widgets: a.widgets }), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => del(`${ds(w, d)}/dashboards/${id}`), onSuccess: inv }),
  };
}

export const useVersions = (w: string, d: string) => useQuery({ queryKey: ["versions", w, d], queryFn: () => get<{ versions: import("./types").VersionInfo[] }>(`${ds(w, d)}/versions`).then((r) => r.versions) });
