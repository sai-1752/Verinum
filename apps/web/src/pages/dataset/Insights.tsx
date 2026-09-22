import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import clsx from "clsx";
import { InsightItem } from "../../components/analysis/InsightItem";
import { EmptyState, QueryError, Skeleton } from "../../components/ui";
import { useInsights } from "../../lib/hooks";
import { titleCase } from "../../lib/format";
import { useDatasetCtx } from "./Layout";

export function InsightsPage() {
  const { wsId, dsId, versionId } = useDatasetCtx();
  const q = useInsights(wsId, dsId, versionId);
  const [cat, setCat] = useState<string>("all");
  const { hash } = useLocation();
  const base = `/w/${wsId}/datasets/${dsId}`;
  const report = q.data?.report;

  useEffect(() => {
    if (!hash || !report) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) { el.scrollIntoView({ block: "start" }); (el.querySelector("button") as HTMLElement | null)?.focus({ preventScroll: true }); }
  }, [hash, report]);

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>;
  if (q.error || !report) return <QueryError error={q.error} retry={() => void q.refetch()} />;
  const cats = ["all", ...Array.from(new Set(report.insights.map((i) => i.category)))];
  const list = cat === "all" ? report.insights : report.insights.filter((i) => i.category === cat);
  const s = report.suppressed;
  return (
    <div>
      <p className="max-w-prose text-sm text-ink-2">Findings are ranked by a fixed formula — size of the effect, relevance to your main metric, statistical support, novelty, data sufficiency and completeness. Open “Show the working” on any finding to see its score, the figures behind it and how to reproduce it.</p>
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
        {cats.map((c) => <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c} className={clsx("rounded-full border px-3 py-1 text-xs", cat === c ? "border-thread bg-thread-wash font-medium text-thread-ink" : "border-line-2 text-ink-2 hover:text-ink")}>{c === "all" ? `All (${report.insights.length})` : titleCase(c)}</button>)}
      </div>
      {list.length === 0 ? <EmptyState className="mt-6" title="Nothing here">No findings in this category.</EmptyState> : (
        <div className="mt-2 divide-y divide-line">{list.map((i) => <InsightItem key={i.id} insight={i} askHref={(x) => `${base}/ask?q=${encodeURIComponent(x)}`} />)}</div>
      )}
      <p className="mt-6 text-xs text-ink-3">Based on {report.rowsAnalysed.toLocaleString("en-US")} rows. {s.belowThreshold + s.duplicatesOfKind > 0 ? `${s.belowThreshold} weaker candidate${s.belowThreshold === 1 ? " was" : "s were"} left out for not clearing the thresholds, and ${s.duplicatesOfKind} for repeating another finding.` : "Every candidate that cleared the thresholds is shown."}</p>
    </div>
  );
}
