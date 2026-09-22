import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";
import { Badge, ErrorNote, Input, PageHeader, QueryError, Select, Skeleton, Tabs, useDebounced } from "../components/ui";
import { get, post } from "../lib/api";
import { useAuth, useAuthConfig } from "../lib/auth";
import { fmtDateTime, fmtRelative, formatNumber } from "../lib/format";
import { useToast } from "../lib/toast";

interface Overview { users: number; workspaces: number; datasets: number; jobsQueued: number; jobsRunning: number; jobsFailed24h: number; aiMessages30d: number; plans: Record<string, number> }
interface AdminWs { id: string; name: string; slug: string; plan_id: string; created_at: string; members: string | number; datasets: string | number; ai_messages_30d: string | number }
interface AdminJob { id: string; workspace_id: string; kind: string; status: string; attempts: number; error: string | null; created_at: string; finished_at: string | null }
interface AdminAudit { id: number | string; workspace_id: string | null; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; created_at: string }

const JOB_TONE: Record<string, "good" | "bad" | "warn" | "thread" | "neutral"> = { succeeded: "good", failed: "bad", running: "thread", queued: "warn", cancelled: "neutral" };

export function AdminPage() {
  const { user, workspaces } = useAuth();
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState(""); const dq = useDebounced(search);
  const [jobStatus, setJobStatus] = useState("");
  const toast = useToast();
  const qc = useQueryClient();
  const plans = useAuthConfig().data?.plans ?? [];
  const enabled = !!user?.isPlatformAdmin;
  const ov = useQuery({ queryKey: ["admin", "overview"], queryFn: () => get<Overview>("/admin/overview"), enabled: enabled && tab === "overview" });
  const wsq = useQuery({ queryKey: ["admin", "ws", dq], queryFn: () => get<{ workspaces: AdminWs[] }>("/admin/workspaces", { q: dq }).then((r) => r.workspaces), enabled: enabled && tab === "workspaces" });
  const jobs = useQuery({ queryKey: ["admin", "jobs", jobStatus], queryFn: () => get<{ jobs: AdminJob[] }>("/admin/jobs", { status: jobStatus }).then((r) => r.jobs), enabled: enabled && tab === "jobs", refetchInterval: tab === "jobs" ? 5000 : false });
  const audit = useQuery({ queryKey: ["admin", "audit"], queryFn: () => get<{ events: AdminAudit[] }>("/admin/audit", { limit: 100 }).then((r) => r.events), enabled: enabled && tab === "audit" });
  const setPlan = useMutation({ mutationFn: (a: { id: string; plan: string }) => post(`/admin/workspaces/${a.id}/plan`, { plan: a.plan }), onSuccess: () => { toast.success("Plan updated."); void qc.invalidateQueries({ queryKey: ["admin"] }); }, onError: (e) => toast.error((e as Error).message) });
  const back = workspaces[0] ? `/w/${workspaces[0].id}` : "/app";

  if (!enabled) return <div className="mx-auto max-w-md px-4 py-24 text-center"><h1>Not available</h1><p className="mt-2 text-sm text-ink-2">This area is for platform administrators.</p><Link to={back} className="btn btn-primary mt-5">Back to the app</Link></div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between"><Link to={back}><Logo /></Link><Link to={back} className="text-sm text-ink-2 hover:text-ink">Back to the app</Link></div>
      <PageHeader title="Platform admin" subtitle="Operational overview across all workspaces. Customer data is never shown here." />
      <Tabs label="Admin sections" value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" }, { id: "workspaces", label: "Workspaces" }, { id: "jobs", label: "Jobs" }, { id: "audit", label: "Audit" }]} />
      <div className="pt-6">
        {tab === "overview" && (ov.isLoading ? <Skeleton className="h-40" /> : ov.error ? <QueryError error={ov.error} /> : ov.data && (
          <div>
            <dl className="grid grid-cols-2 gap-y-6 sm:grid-cols-4" data-testid="admin-overview">
              {([["Users", ov.data.users], ["Workspaces", ov.data.workspaces], ["Datasets", ov.data.datasets], ["AI answers (30 days)", ov.data.aiMessages30d], ["Jobs queued", ov.data.jobsQueued], ["Jobs running", ov.data.jobsRunning], ["Failed jobs (24 h)", ov.data.jobsFailed24h]] as [string, number][]).map(([k, v]) => <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd className="num font-serif text-3xl text-ink">{formatNumber(Number(v))}</dd></div>)}
            </dl>
            <h2 className="mt-8 text-lg">Workspaces by plan</h2>
            <ul className="mt-2 flex flex-wrap gap-2">{Object.entries(ov.data.plans).map(([p, n]) => <li key={p}><Badge>{p}: {n}</Badge></li>)}</ul>
          </div>
        ))}
        {tab === "workspaces" && (
          <div>
            <div className="max-w-xs"><Input type="search" aria-label="Search workspaces" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <ErrorNote className="mt-3" error={setPlan.error} />
            {wsq.isLoading ? <Skeleton className="mt-4 h-40" /> : wsq.error ? <QueryError error={wsq.error} /> : (
              <div className="mt-4 overflow-x-auto rounded-md border border-line bg-panel"><table className="w-full min-w-[40rem]"><thead className="thead"><tr><th>Workspace</th><th className="!text-right">Members</th><th className="!text-right">Datasets</th><th className="!text-right">AI (30 d)</th><th>Plan</th><th>Created</th></tr></thead>
                <tbody>{(wsq.data ?? []).map((w) => <tr key={w.id} className="trow"><td><span className="font-medium text-ink">{w.name}</span><span className="caption block">{w.slug}</span></td><td className="num text-right">{Number(w.members)}</td><td className="num text-right">{Number(w.datasets)}</td><td className="num text-right">{Number(w.ai_messages_30d)}</td>
                  <td><Select aria-label={`Plan for ${w.name}`} className="!h-8 !w-28 !text-xs" value={w.plan_id} onChange={(e) => setPlan.mutate({ id: w.id, plan: e.target.value })}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></td><td className="whitespace-nowrap text-ink-2">{fmtRelative(w.created_at)}</td></tr>)}</tbody></table></div>
            )}
          </div>
        )}
        {tab === "jobs" && (
          <div>
            <Select aria-label="Filter by status" className="!w-44" value={jobStatus} onChange={(e) => setJobStatus(e.target.value)}><option value="">All statuses</option>{["queued", "running", "succeeded", "failed", "cancelled"].map((s) => <option key={s}>{s}</option>)}</Select>
            {jobs.isLoading ? <Skeleton className="mt-4 h-40" /> : jobs.error ? <QueryError error={jobs.error} /> : (
              <div className="mt-4 overflow-x-auto rounded-md border border-line bg-panel"><table className="w-full min-w-[40rem]"><thead className="thead"><tr><th>Job</th><th>Status</th><th className="!text-right">Attempts</th><th>Started</th><th>Error</th></tr></thead>
                <tbody>{(jobs.data ?? []).map((j) => <tr key={j.id} className="trow align-top"><td>{j.kind}<span className="caption block">{j.id.slice(0, 8)}</span></td><td><Badge tone={JOB_TONE[j.status] ?? "neutral"}>{j.status}</Badge></td><td className="num text-right">{j.attempts}</td><td className="whitespace-nowrap text-ink-2" title={fmtDateTime(j.created_at)}>{fmtRelative(j.created_at)}</td><td className="max-w-xs truncate text-xs text-ink-3" title={j.error ?? ""}>{j.error ?? ""}</td></tr>)}</tbody></table></div>
            )}
          </div>
        )}
        {tab === "audit" && (audit.isLoading ? <Skeleton className="h-40" /> : audit.error ? <QueryError error={audit.error} /> : (
          <div className="overflow-x-auto rounded-md border border-line bg-panel"><table className="w-full min-w-[36rem]"><thead className="thead"><tr><th>When</th><th>Action</th><th>Target</th><th>Workspace</th></tr></thead>
            <tbody>{(audit.data ?? []).map((e) => <tr key={String(e.id)} className="trow"><td className="whitespace-nowrap text-ink-2">{fmtRelative(e.created_at)}</td><td>{e.action}</td><td className="text-xs text-ink-3">{e.target_type ?? ""} {e.target_id?.slice(0, 8) ?? ""}</td><td className="text-xs text-ink-3">{e.workspace_id?.slice(0, 8) ?? "platform"}</td></tr>)}</tbody></table></div>
        ))}
      </div>
    </div>
  );
}
