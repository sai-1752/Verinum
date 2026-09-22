import clsx from "clsx";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChartView } from "../../components/charts/ChartView";
import { KpiStrip } from "../../components/analysis/KpiStrip";
import { ProvenanceDisclosure } from "../../components/analysis/Provenance";
import { Button, Checkbox, Dialog, EmptyState, ErrorNote, Field, Input, Notice, Popover, QueryError, Select, Skeleton } from "../../components/ui";
import { useColumns, useDashboard, useDashboardMutations, useSavedDashboards } from "../../lib/hooks";
import type { DashboardFilterSpec, Filter, WidgetResult, WidgetSpec } from "../../lib/types";
import { useToast } from "../../lib/toast";
import { formatNumber } from "../../lib/format";
import { useDatasetCtx } from "./Layout";

const SPAN: Record<WidgetSpec["size"], string> = { sm: "lg:col-span-4", md: "lg:col-span-6", lg: "lg:col-span-8", full: "lg:col-span-12" };
const SPAN_MD: Record<WidgetSpec["size"], string> = { sm: "md:col-span-6", md: "md:col-span-6", lg: "md:col-span-12", full: "md:col-span-12" };

type Mode = { kind: "plan" } | { kind: "saved"; id: string; name: string; widgets: WidgetSpec[] } | { kind: "custom"; widgets: WidgetSpec[]; name?: string; id?: string };

function CategoryFilter({ f, value, onChange }: { f: DashboardFilterSpec; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Popover label={`Filter by ${f.label}`} trigger={({ toggle, open, id }) => (
      <button onClick={toggle} aria-expanded={open} aria-controls={id} className={clsx("rounded-full border px-3 py-1 text-xs", value.length ? "border-thread bg-thread-wash font-medium text-thread-ink" : "border-line-2 text-ink-2 hover:text-ink")}>
        {f.label}{value.length ? `: ${value.length === 1 ? value[0] : `${value.length} selected`}` : ""}
      </button>)}>
      {() => (
        <div className="max-h-64 w-60 overflow-auto p-1">
          {(f.values ?? []).map((v) => (
            <div key={v.value} className="px-1 py-1"><Checkbox checked={value.includes(v.value)} onChange={(c) => onChange(c ? [...value, v.value] : value.filter((x) => x !== v.value))} label={<>{v.value || "(blank)"} <span className="text-ink-3">{formatNumber(v.count)}</span></>} /></div>
          ))}
          {value.length > 0 && <button onClick={() => onChange([])} className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-thread hover:bg-sunk">Clear</button>}
        </div>
      )}
    </Popover>
  );
}

function WidgetCard({ r, editing, first, last, onHide, onMove, askHref }: { r: WidgetResult; editing: boolean; first: boolean; last: boolean; onHide: () => void; onMove: (d: -1 | 1) => void; askHref: string }) {
  const s = r.spec;
  return (
    <section className={clsx("col-span-12 border-t border-line pt-4", SPAN_MD[s.size], SPAN[s.size])} aria-label={s.title} data-testid="widget">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[1.05rem]">{s.title}</h3>
          <p className="mt-0.5 text-xs text-ink-3">{s.why}</p>
        </div>
        {editing && (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" onClick={() => onMove(-1)} disabled={first} aria-label={`Move ${s.title} earlier`}>Earlier</Button>
            <Button size="sm" variant="ghost" onClick={() => onMove(1)} disabled={last} aria-label={`Move ${s.title} later`}>Later</Button>
            <Button size="sm" variant="ghost" onClick={onHide} aria-label={`Remove ${s.title}`}>Remove</Button>
          </div>
        )}
      </div>
      {r.status === "ok" && r.chart ? (
        <>
          <ChartView spec={r.chart} hideHeader height={s.size === "sm" ? 220 : 260} />
          {r.summary && <p className="mt-2 max-w-prose whitespace-pre-line text-xs leading-5 text-ink-2">{r.summary.split("\n")[0]}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {r.provenance && <ProvenanceDisclosure provenance={r.provenance} facts={r.facts} />}
            <Link to={askHref} className="text-xs text-ink-3 underline underline-offset-2 hover:text-ink">Ask about this</Link>
          </div>
        </>
      ) : (
        <div className="rounded-md bg-sunk px-4 py-5 text-sm text-ink-2" data-testid="widget-unavailable"><p className="font-medium text-ink">Not available for this data</p><p className="mt-0.5">{r.reason ?? "This chart can't be built from the current selection."}</p></div>
      )}
    </section>
  );
}

function AddWidget({ open, onClose, onAdd, wsId, dsId, versionId }: { open: boolean; onClose: () => void; onAdd: (w: WidgetSpec) => void; wsId: string; dsId: string; versionId: string }) {
  const cols = useColumns(wsId, dsId, versionId);
  const measures = (cols.data?.columns ?? []).filter((c) => c.type === "numeric" && c.analyzable);
  const dims = (cols.data?.columns ?? []).filter((c) => (c.chartDimension || c.groupable) && c.analyzable);
  const [kind, setKind] = useState<"group_by" | "top_n" | "time_series" | "distribution">("group_by");
  const [metric, setMetric] = useState(""); const [dim, setDim] = useState("");
  const m = metric || measures[0]?.name || ""; const d = dim || dims[0]?.name || "";
  const build = (): WidgetSpec => {
    const id = `custom:${kind}:${m}:${d}:${Date.now().toString(36)}`;
    if (kind === "group_by") return { id, title: `${m} by ${d}`, why: "Added by you.", tool: "group_by", params: { dimension: d, metric: m, limit: 12 }, size: "md" };
    if (kind === "top_n") return { id, title: `Top ${d} values by ${m}`, why: "Added by you.", tool: "top_n", params: { dimension: d, metric: m, n: 10 }, size: "md" };
    if (kind === "time_series") return { id, title: `${m} over time`, why: "Added by you.", tool: "time_series", params: { metric: m }, size: "full" };
    return { id, title: `Distribution of ${m}`, why: "Added by you.", tool: "distribution", params: { column: m }, size: "sm" };
  };
  const needsDim = kind === "group_by" || kind === "top_n";
  return (
    <Dialog open={open} onClose={onClose} title="Add a chart" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!m || (needsDim && !d)} onClick={() => { onAdd(build()); onClose(); }}>Add chart</Button></>}>
      <div className="space-y-3">
        <Field label="Chart">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="group_by">Breakdown by category</option><option value="top_n">Top values</option><option value="time_series">Trend over time</option><option value="distribution">Distribution</option></Select>}</Field>
        <Field label="Measure">{(p) => <Select {...p} value={m} onChange={(e) => setMetric(e.target.value)}>{measures.map((c) => <option key={c.name}>{c.name}</option>)}</Select>}</Field>
        {needsDim && <Field label="Category">{(p) => <Select {...p} value={d} onChange={(e) => setDim(e.target.value)}>{dims.map((c) => <option key={c.name}>{c.name}</option>)}</Select>}</Field>}
        <p className="text-xs text-ink-3">Charts are calculated by the same tools the AI analyst uses, so numbers here always match its answers.</p>
      </div>
    </Dialog>
  );
}

export function DashboardPage() {
  const { wsId, dsId, versionId, can } = useDatasetCtx();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>({ kind: "plan" });
  const [editing, setEditing] = useState(false);
  const [dateFrom, setFrom] = useState(""); const [dateTo, setTo] = useState("");
  const [cats, setCats] = useState<Record<string, string[]>>({});
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false); const [name, setName] = useState("");
  const saved = useSavedDashboards(wsId, dsId);
  const mut = useDashboardMutations(wsId, dsId);
  const canSave = can("dashboard.save");

  const filters: Filter[] = useMemo(() => Object.entries(cats).filter(([, v]) => v.length).map(([column, values]) => ({ column, op: "in", values })), [cats]);
  const widgets = mode.kind === "plan" ? undefined : mode.widgets;
  const q = useDashboard(wsId, dsId, versionId, { filters, ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}), ...(widgets ? { widgets } : {}) });
  const view = q.data?.view;
  const filterSpecs = q.data?.filters ?? [];
  const dateSpec = filterSpecs.find((f) => f.kind === "date");
  const dirty = filters.length > 0 || !!dateFrom || !!dateTo;

  const startEdit = () => { if (mode.kind === "plan" && view) setMode({ kind: "custom", widgets: view.widgets.map((w) => w.spec) }); setEditing(true); };
  const setWidgets = (fn: (w: WidgetSpec[]) => WidgetSpec[]) => setMode((m) => (m.kind === "plan" ? m : m.kind === "saved" ? { kind: "custom", widgets: fn(m.widgets), name: m.name, id: m.id } : { ...m, widgets: fn(m.widgets) }));
  const move = (i: number, d: -1 | 1) => setWidgets((w) => { const n = [...w]; const j = i + d; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  const doSave = () => {
    const w = mode.kind === "plan" ? (view?.widgets.map((x) => x.spec) ?? []) : mode.widgets;
    const existing = mode.kind === "custom" && mode.id ? mode.id : mode.kind === "saved" ? mode.id : null;
    if (existing && !saving) { mut.update.mutate({ id: existing, name: (mode.kind === "custom" ? mode.name : mode.kind === "saved" ? mode.name : "") || "Dashboard", widgets: w }, { onSuccess: () => { toast.success("Dashboard saved."); setEditing(false); } }); return; }
    mut.save.mutate({ name: name.trim(), widgets: w }, { onSuccess: (r) => { toast.success("Dashboard saved."); setSaving(false); setMode({ kind: "saved", id: r.id, name: name.trim(), widgets: w }); setEditing(false); setName(""); } });
  };

  if (q.error && !q.data) return <QueryError error={q.error} retry={() => void q.refetch()} />;
  const results = view?.widgets ?? [];
  const activeName = mode.kind === "saved" ? mode.name : mode.kind === "custom" ? mode.name ?? "Unsaved changes" : "Suggested dashboard";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Choose a dashboard" className="!w-auto min-w-[12rem]" value={mode.kind === "saved" ? mode.id : mode.kind === "plan" ? "plan" : "custom"}
          onChange={(e) => { setEditing(false); if (e.target.value === "plan") setMode({ kind: "plan" }); else { const s = saved.data?.find((x) => x.id === e.target.value); if (s) setMode({ kind: "saved", id: s.id, name: s.name, widgets: s.widgets }); } }}>
          <option value="plan">Suggested dashboard</option>
          {(saved.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          {mode.kind === "custom" && <option value="custom">{activeName}</option>}
        </Select>
        <div className="ml-auto flex flex-wrap gap-2">
          {canSave && !editing && <Button onClick={startEdit} disabled={!view}>Customize</Button>}
          {editing && <><Button onClick={() => setAdding(true)}>Add a chart</Button><Button onClick={() => { setEditing(false); if (mode.kind === "custom" && !mode.id) setMode({ kind: "plan" }); }}>Done</Button>
            {(mode.kind === "saved" || (mode.kind === "custom" && mode.id)) ? <Button variant="primary" loading={mut.update.isPending} onClick={doSave}>Save changes</Button> : <Button variant="primary" onClick={() => setSaving(true)}>Save as…</Button>}</>}
          {canSave && mode.kind === "saved" && !editing && <Button variant="ghost" onClick={() => mut.remove.mutate(mode.id, { onSuccess: () => { setMode({ kind: "plan" }); toast.success("Dashboard deleted."); } })}>Delete</Button>}
        </div>
      </div>

      {filterSpecs.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          <span className="text-xs text-ink-3">Filter</span>
          {dateSpec && (
            <span className="flex items-center gap-1.5 text-xs text-ink-2">
              <label className="sr-only" htmlFor="df">From</label><input id="df" type="date" className="input !h-8 !w-auto !px-2 text-xs" min={dateSpec.min} max={dateSpec.max} value={dateFrom} onChange={(e) => setFrom(e.target.value)} />
              to
              <label className="sr-only" htmlFor="dt">To</label><input id="dt" type="date" className="input !h-8 !w-auto !px-2 text-xs" min={dateSpec.min} max={dateSpec.max} value={dateTo} onChange={(e) => setTo(e.target.value)} />
            </span>
          )}
          {filterSpecs.filter((f) => f.kind === "category").map((f) => <CategoryFilter key={f.column} f={f} value={cats[f.column] ?? []} onChange={(v) => setCats((c) => ({ ...c, [f.column]: v }))} />)}
          {dirty && <button className="text-xs text-thread underline underline-offset-2" onClick={() => { setCats({}); setFrom(""); setTo(""); }}>Clear filters</button>}
        </div>
      )}
      {view && dirty && <p className="mt-2 text-xs text-ink-3" role="status">Showing {formatNumber(view.rowsInScope)} of {formatNumber(view.totalRows)} rows.{view.appliedFilters.length > 0 && ` ${view.appliedFilters.join("; ")}.`}</p>}

      <div className="mt-6">
        {q.isLoading ? <Skeleton className="h-28" /> : view && <KpiStrip kpis={view.kpis} />}
        {view?.notes.map((n, i) => <Notice key={i} tone="info" className="mt-3">{n}</Notice>)}
      </div>

      {q.isLoading && <div className="mt-8 grid gap-8 md:grid-cols-2"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>}
      {view && results.length === 0 && <EmptyState className="mt-8" title="This dashboard is empty">{editing ? "Add a chart to get started." : "Choose Customize to add charts."}</EmptyState>}
      <div className={clsx("mt-8 grid grid-cols-12 gap-x-10 gap-y-10", q.isFetching && q.data && "opacity-70 transition-opacity")} aria-busy={q.isFetching}>
        {results.map((r, i) => (
          <WidgetCard key={r.spec.id} r={r} editing={editing} first={i === 0} last={i === results.length - 1} onHide={() => setWidgets((w) => w.filter((x) => x.id !== r.spec.id))} onMove={(d) => move(i, d)}
            askHref={`/w/${wsId}/datasets/${dsId}/ask?q=${encodeURIComponent(`Tell me about: ${r.spec.title}`)}`} />
        ))}
      </div>

      <AddWidget open={adding} onClose={() => setAdding(false)} onAdd={(w) => setWidgets((x) => [...x, w])} wsId={wsId} dsId={dsId} versionId={versionId} />
      <Dialog open={saving} onClose={() => setSaving(false)} title="Save dashboard" footer={<><Button onClick={() => setSaving(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={mut.save.isPending} onClick={doSave}>Save dashboard</Button></>}>
        <Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Weekly review" />}</Field>
        <ErrorNote className="mt-3" error={mut.save.error} />
      </Dialog>
    </div>
  );
}
