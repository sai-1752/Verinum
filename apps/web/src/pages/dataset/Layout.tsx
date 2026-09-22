import clsx from "clsx";
import { createContext, useContext } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { Badge, Button, ErrorNote, Notice, PageLoading, QualityBadge, QueryError } from "../../components/ui";
import { ProcessingView } from "../../components/analysis/ProcessingView";
import { useDataset, useDatasetMutations, useQuality } from "../../lib/hooks";
import { formatNumber, fmtRelative } from "../../lib/format";
import type { DatasetDetail, VersionInfo } from "../../lib/types";
import { useWorkspace } from "../../lib/workspace";
import { ApiError } from "../../lib/api";

export interface DatasetCtx { wsId: string; dsId: string; dataset: DatasetDetail; version: VersionInfo; versionId: string; can: (a: string) => boolean }
const C = createContext<DatasetCtx | null>(null);
export function useDatasetCtx(): DatasetCtx { const v = useContext(C); if (!v) throw new Error("outside dataset layout"); return v; }

const TABS = [
  { to: "overview", label: "Overview" }, { to: "insights", label: "Insights" }, { to: "dashboard", label: "Dashboard" }, { to: "forecast", label: "Forecast" },
  { to: "explore", label: "Explore" }, { to: "ask", label: "Ask" }, { to: "data", label: "Data and quality" },
];

export function DatasetLayout() {
  const { dsId = "" } = useParams();
  const { id: wsId, can } = useWorkspace();
  const q = useDataset(wsId, dsId);
  const m = useDatasetMutations(wsId);
  const d = q.data;

  if (q.isLoading) return <PageLoading label="Opening dataset" />;
  if (q.error) {
    const nf = q.error instanceof ApiError && q.error.status === 404;
    return nf ? <div className="mx-auto max-w-md py-20 text-center"><h1>Dataset not found</h1><p className="mt-2 text-sm text-ink-2">It may have been deleted.</p><Link to={`/w/${wsId}`} className="btn btn-primary mt-5">Back to datasets</Link></div> : <QueryError error={q.error} retry={() => void q.refetch()} />;
  }
  if (!d) return null;

  if (d.status === "queued" || d.status === "processing") {
    return <ProcessingView job={d.job} name={d.name} onCancel={can("dataset.update") && d.job ? () => m.cancelJob.mutate(d.job!.id) : undefined} cancelling={m.cancelJob.isPending} />;
  }
  if (d.status === "deleting") return <div className="mx-auto max-w-md py-20 text-center"><h1>Deleting…</h1><p className="mt-2 text-sm text-ink-2">This dataset is being removed.</p></div>;
  if (d.status === "failed" || !d.version) {
    return (
      <div className="mx-auto max-w-xl py-14" data-testid="dataset-failed">
        <h1 className="text-[1.7rem]">We couldn't process “{d.name}”</h1>
        <div className="mt-4"><Notice tone="bad">{d.error ?? d.version?.error ?? "The file could not be read."}</Notice></div>
        <p className="mt-4 text-sm text-ink-2">Nothing was added to your analysis. Check that the file opens correctly in a spreadsheet app, then try again or upload a different file.</p>
        <div className="mt-5 flex gap-2">
          {can("dataset.update") && <Button variant="primary" loading={m.reprocess.isPending} onClick={() => m.reprocess.mutate({ id: d.id, options: {} })}>Try again</Button>}
          <Link to={`/w/${wsId}`} className="btn btn-quiet">Back to datasets</Link>
        </div>
        <ErrorNote className="mt-3" error={m.reprocess.error} />
      </div>
    );
  }

  const v = d.version;
  const ctx: DatasetCtx = { wsId, dsId, dataset: d, version: v, versionId: v.id, can };
  return (
    <C.Provider value={ctx}>
      <div>
        <div className="mb-1 text-xs text-ink-3"><Link to={`/w/${wsId}`} className="hover:text-ink">Datasets</Link></div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate" data-testid="dataset-title">{d.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
              <span className="num">{formatNumber(v.rowCount ?? 0)} rows · {v.columnCount} columns</span>
              <span aria-hidden>·</span><span>version {v.version}</span>
              <span aria-hidden>·</span><span>updated {fmtRelative(d.updatedAt)}</span>
              {d.isDemo && <Badge tone="thread">Sample data</Badge>}
            </p>
          </div>
          <QualityLink />
        </div>
        {d.pending && (
          <div className="mt-4">
            {d.pending.status === "failed" ? <Notice tone="bad" title="Your changes couldn't be applied">{d.pending.error ?? "Processing failed."} The previous version is still in use.</Notice> : <div className="rounded-md border border-line bg-panel px-4"><ProcessingView job={d.job} name="Applying your changes" compact /></div>}
          </div>
        )}
        <nav className="mt-5 flex gap-1 overflow-x-auto border-b border-line" aria-label="Dataset sections">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => clsx("-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium", isActive ? "border-thread text-ink" : "border-transparent text-ink-2 hover:text-ink")}>{t.label}</NavLink>
          ))}
        </nav>
        <div className="pt-7"><Outlet /></div>
      </div>
    </C.Provider>
  );
}

function QualityLink() {
  const c = useDatasetCtx();
  // the score itself lives on the Data tab; here it is only a shortcut
  return <Link to="data" className="text-sm text-ink-2 hover:text-ink" aria-label="See data quality"><span className="underline underline-offset-2">Data quality</span> <QualityScoreInline wsId={c.wsId} dsId={c.dsId} /></Link>;
}

function QualityScoreInline({ wsId, dsId }: { wsId: string; dsId: string }) {
  const { versionId } = useDatasetCtx();
  const q = useQuality(wsId, dsId, versionId);
  if (!q.data) return null;
  return <QualityBadge score={q.data.quality.score} label={q.data.quality.label} />;
}
