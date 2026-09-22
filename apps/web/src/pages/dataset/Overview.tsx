import { Link } from "react-router-dom";
import { KpiStrip } from "../../components/analysis/KpiStrip";
import { InsightItem } from "../../components/analysis/InsightItem";
import { EmptyState, QueryError, Skeleton, Notice, QualityBadge } from "../../components/ui";
import { useDashboard, useInsights, useQuality, useStarterQuestions } from "../../lib/hooks";
import { useDatasetCtx } from "./Layout";

const enc = encodeURIComponent;

export function OverviewPage() {
  const { wsId, dsId, versionId, version } = useDatasetCtx();
  const ins = useInsights(wsId, dsId, versionId);
  const dash = useDashboard(wsId, dsId, versionId, { filters: [] });
  const quality = useQuality(wsId, dsId, versionId);
  const starters = useStarterQuestions(wsId, dsId, versionId);
  const base = `/w/${wsId}/datasets/${dsId}`;
  const report = ins.data?.report;

  return (
    <div className="space-y-10">
      {ins.error && <QueryError error={ins.error} retry={() => void ins.refetch()} />}

      <section aria-labelledby="summary-h">
        {ins.isLoading ? <div className="space-y-2"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div> : report && (
          <>
            <h2 id="summary-h" className="sr-only">Summary</h2>
            <p className="max-w-3xl font-serif text-[1.7rem] leading-[1.3] text-ink" data-testid="exec-headline">{report.summary.headline}</p>
            {report.summary.bullets.length > 0 && (
              <ul className="mt-4 max-w-3xl space-y-2 text-[0.98rem] leading-6 text-ink-2">
                {report.summary.bullets.map((b, i) => <li key={i} className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-thread" aria-hidden />{b.insightId ? <Link to={`${base}/insights#ins-${enc(b.insightId)}`} className="hover:text-ink">{b.text}</Link> : b.text}</li>)}
              </ul>
            )}
            {report.summary.caveats.length > 0 && <div className="mt-4 max-w-3xl space-y-1 text-xs text-ink-3">{report.summary.caveats.map((c, i) => <p key={i}>{c}</p>)}</div>}
          </>
        )}
      </section>

      <section aria-label="Headline figures">
        {dash.isLoading ? <Skeleton className="h-28" /> : dash.data ? <KpiStrip kpis={dash.data.view.kpis} /> : null}
        {dash.data?.view.notes.map((n, i) => <p key={i} className="mt-2 text-xs text-ink-3">{n}</p>)}
      </section>

      {version.warnings.length > 0 && <Notice tone="warn" title="Things to know about this file">{version.warnings.join(" ")}</Notice>}

      <section aria-labelledby="top-h">
        <div className="flex items-baseline justify-between gap-3"><h2 id="top-h">What stands out</h2><Link className="link text-sm" to={`${base}/insights`}>All {report?.insights.length ?? ""} findings</Link></div>
        {ins.isLoading ? <div className="mt-4 space-y-4"><Skeleton className="h-40" /><Skeleton className="h-40" /></div> : report && report.insights.length === 0 ? <EmptyState className="mt-4" title="No strong findings yet">The data doesn't contain patterns that clear the significance and size thresholds. You can still ask questions or explore the rows.</EmptyState> : (
          <div className="mt-1 divide-y divide-line">
            {report?.insights.slice(0, 3).map((i) => <InsightItem key={i.id} insight={i} askHref={(q) => `${base}/ask?q=${enc(q)}`} />)}
          </div>
        )}
      </section>

      <div className="grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="ask-h">
          <h2 id="ask-h">Ask something</h2>
          <ul className="mt-3 space-y-1.5">
            {(starters.data ?? []).slice(0, 5).map((q) => <li key={q}><Link to={`${base}/ask?q=${enc(q)}`} className="block rounded-md border border-line bg-panel px-3.5 py-2.5 text-sm text-ink hover:border-thread">{q}</Link></li>)}
            {starters.isLoading && [0, 1, 2].map((i) => <li key={i}><Skeleton className="h-10" /></li>)}
          </ul>
        </section>
        <section aria-labelledby="q-h">
          <h2 id="q-h">Data quality</h2>
          {quality.data && (
            <div className="mt-3">
              <p className="flex items-center gap-2 text-sm text-ink-2"><QualityBadge score={quality.data.quality.score} label={quality.data.quality.label} /> {quality.data.quality.completeness.toFixed(1)}% of cells are filled in.</p>
              <ul className="mt-3 space-y-2">
                {quality.data.quality.issues.slice(0, 3).map((i) => <li key={i.id} className="text-sm text-ink-2"><span className="text-ink">{i.detail}</span></li>)}
                {quality.data.quality.issues.length === 0 && <li className="text-sm text-ink-2">No issues found.</li>}
              </ul>
              <Link to={`${base}/data`} className="link mt-3 inline-block text-sm">Review and fix issues</Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
