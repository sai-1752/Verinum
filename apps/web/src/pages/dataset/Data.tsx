import clsx from "clsx";
import { useMemo, useState } from "react";
import { Badge, Button, ErrorNote, Notice, QualityBadge, QueryError, Select, Skeleton } from "../../components/ui";
import { useDatasetMutations, useProfile, useQuality, useVersions } from "../../lib/hooks";
import type { ProcessOptions, Suggestion } from "../../lib/types";
import { fmtDateTime, formatNumber, titleCase } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useDatasetCtx } from "./Layout";

const SEV_TONE = { high: "bad", medium: "warn", low: "neutral" } as const;
const T_TONE = { info: "neutral", notice: "thread", warning: "warn" } as const;

export function DataPage() {
  const { wsId, dsId, versionId, version, dataset, can } = useDatasetCtx();
  const q = useQuality(wsId, dsId, versionId);
  const prof = useProfile(wsId, dsId, versionId);
  const versions = useVersions(wsId, dsId);
  const m = useDatasetMutations(wsId);
  const toast = useToast();
  const canEdit = can("dataset.update");
  const [excluded, setExcluded] = useState<string[] | null>(null);
  const [showAllCols, setShowAllCols] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const LOG_PREVIEW = 6;
  const current: ProcessOptions = version.options;
  const busy = !!dataset.pending && dataset.pending.status !== "failed";

  const apply = (change: Partial<ProcessOptions>, message = "Applying your change — a new version is being built.") => {
    m.reprocess.mutate({ id: dsId, options: { ...current, ...change } }, { onSuccess: () => toast.info(message) });
  };
  const suggestionActions = (s: Suggestion & { column?: string }) => {
    switch (s.kind) {
      case "remove_duplicates": return <Button size="sm" variant="primary" disabled={!canEdit || busy} onClick={() => apply({ removeDuplicates: true })}>Remove duplicates</Button>;
      case "normalize_labels": return <Button size="sm" variant="primary" disabled={!canEdit || busy} onClick={() => apply({ normalizeLabels: true })}>Merge variants</Button>;
      case "confirm_date_order": return (
        <span className="flex gap-1.5">
          <Button size="sm" disabled={!canEdit || busy} onClick={() => apply({ dateOrders: { ...current.dateOrders, [s.column!]: "dmy" } })}>Day first</Button>
          <Button size="sm" disabled={!canEdit || busy} onClick={() => apply({ dateOrders: { ...current.dateOrders, [s.column!]: "mdy" } })}>Month first</Button>
        </span>);
      case "drop_empty_column": return <Button size="sm" disabled={!canEdit || busy} onClick={() => apply({ excludeColumns: [...current.excludeColumns, s.column!] })}>Exclude column</Button>;
      default: return null;
    }
  };

  const cols = prof.data?.profile.columns ?? [];
  const exSet = useMemo(() => new Set(excluded ?? current.excludeColumns), [excluded, current.excludeColumns]);
  const exChanged = excluded !== null && (excluded.length !== current.excludeColumns.length || excluded.some((c) => !current.excludeColumns.includes(c)));

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-48" /></div>;
  if (q.error || !q.data) return <QueryError error={q.error} retry={() => void q.refetch()} />;
  const { quality, transformations, suggestions } = q.data;
  const tables = version.availableTables;

  return (
    <div className="space-y-12">
      <section aria-labelledby="qs-h" className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div>
          <h2 id="qs-h" className="sr-only">Quality score</h2>
          <p className="num font-serif text-[3.5rem] leading-none text-ink" data-testid="quality-score">{quality.score}</p>
          <p className="mt-1"><QualityBadge score={quality.score} label={quality.label} /></p>
        </div>
        <div className="max-w-xl flex-1 basis-72 text-sm leading-6 text-ink-2">
          <p><span className="num text-ink">{quality.completeness.toFixed(1)}%</span> of cells are filled in. We found <span className="num text-ink">{quality.counts.high}</span> serious, <span className="num text-ink">{quality.counts.medium}</span> moderate and <span className="num text-ink">{quality.counts.low}</span> minor issue{quality.issues.length === 1 ? "" : "s"}.</p>
          <p className="mt-2 text-ink-3">The score starts at 100 and loses points for missing values, duplicate rows, implausible values, ambiguous dates and inconsistent labels, weighted by how much of the data each affects. Nothing here changes your analysis until you choose to apply a fix.</p>
        </div>
      </section>

      {tables.length > 1 && (
        <section aria-labelledby="tbl-h">
          <h2 id="tbl-h" className="text-xl">Which table should we analyse?</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-2">This file contains {tables.length} tables. Only one is analysed at a time; switching builds a new version.</p>
          <div className="mt-3 flex max-w-md gap-2">
            <Select aria-label="Table to analyse" value={version.tableIndex} disabled={!canEdit || busy} onChange={(e) => apply({ tableIndex: Number(e.target.value) })}>
              {tables.map((t) => <option key={t.index} value={t.index}>{t.name} ({formatNumber(t.rows)} rows, {t.columns} columns)</option>)}
            </Select>
          </div>
        </section>
      )}

      {(suggestions.length > 0 || busy || m.reprocess.error) && (
        <section aria-labelledby="fix-h">
          <h2 id="fix-h" className="text-xl">Suggested fixes</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-2">These change your data, so they're offered rather than applied. Each one creates a new version; your original file is never modified.</p>
          <ErrorNote className="mt-3" error={m.reprocess.error} />
          {busy && <Notice className="mt-3" tone="info">A new version is being built. Suggestions will update when it finishes.</Notice>}
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {suggestions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5" data-testid="suggestion">
                <div className="min-w-0 max-w-2xl flex-1 basis-80"><p className="text-sm text-ink">{s.detail}</p><p className="mt-0.5 text-xs text-ink-3">{s.proposedAction}</p></div>
                {canEdit ? suggestionActions(s as Suggestion & { column?: string }) : <span className="text-xs text-ink-3">Ask an analyst to apply this</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="iss-h">
        <h2 id="iss-h" className="text-xl">What we found</h2>
        {quality.issues.length === 0 ? <p className="mt-2 text-sm text-ink-2">No issues found.</p> : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {quality.issues.map((i) => (
              <li key={i.id} className="flex gap-3 py-3.5" data-testid="quality-issue">
                <Badge tone={SEV_TONE[i.severity]} className="mt-0.5 h-fit shrink-0">{titleCase(i.severity)}</Badge>
                <div className="min-w-0"><p className="text-sm text-ink">{i.detail}</p><p className="mt-0.5 text-xs text-ink-3">{i.fix}</p></div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="log-h">
        <div className="flex items-baseline justify-between"><h2 id="log-h" className="text-xl">What we changed automatically</h2>{transformations.length > LOG_PREVIEW && <button className="text-sm text-thread underline underline-offset-2" onClick={() => setShowLog((s) => !s)} aria-expanded={showLog}>{showLog ? "Show fewer" : `Show all ${transformations.length}`}</button>}</div>
        <p className="mt-1 max-w-prose text-sm text-ink-2">Every automatic change is lossless and listed here. Anything that would remove rows or merge labels waits for your approval above.</p>
        {transformations.length === 0 ? <p className="mt-3 text-sm text-ink-3">Nothing needed changing.</p> : (
          <ul className="mt-3 divide-y divide-line border-y border-line" data-testid="transform-log">
            {(showLog ? transformations : transformations.slice(0, LOG_PREVIEW)).map((t) => (
              <li key={t.id} className="flex gap-3 py-3">
                <Badge tone={T_TONE[t.severity]} className="mt-0.5 h-fit shrink-0">{titleCase(t.kind)}</Badge>
                <div className="min-w-0 text-sm"><p className="text-ink">{t.detail}</p>{t.examples && t.examples.length > 0 && <p className="mt-0.5 text-xs text-ink-3">e.g. {t.examples.join(", ")}</p>}</div>
                <span className="num ml-auto shrink-0 text-xs text-ink-3">{formatNumber(t.affected)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="col-h">
        <div className="flex items-baseline justify-between gap-3"><h2 id="col-h" className="text-xl">Columns</h2>
          {canEdit && exChanged && <Button variant="primary" size="sm" disabled={busy} loading={m.reprocess.isPending} onClick={() => apply({ excludeColumns: excluded! }, "Rebuilding without the excluded columns.")}>Apply exclusions</Button>}</div>
        <p className="mt-1 max-w-prose text-sm text-ink-2">How each column was understood, and why. Exclude columns you don't want analysed (for example internal IDs).</p>
        {prof.isLoading ? <Skeleton className="mt-3 h-48" /> : (
          <div className="mt-3 overflow-x-auto rounded-md border border-line bg-panel">
            <table className="w-full min-w-[46rem]">
              <thead className="thead"><tr><th>Column</th><th>Type</th><th>Meaning</th><th className="!text-right">Missing</th><th className="!text-right">Distinct</th>{canEdit && <th>Exclude</th>}</tr></thead>
              <tbody>
                {(showAllCols ? cols : cols.slice(0, 12)).map((c) => (
                  <tr key={c.name} className="trow align-top" data-testid="column-row">
                    <td><span className="font-medium text-ink">{c.name}</span>{c.reasons.length > 0 && <details className="text-xs text-ink-3"><summary className="cursor-pointer select-none hover:text-ink [&::-webkit-details-marker]:hidden"><span className="underline underline-offset-2">Why?</span></summary><ul className="mt-1 list-disc pl-4">{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details>}</td>
                    <td>{titleCase(c.type)}<span className="caption block">{Math.round(c.confidence * 100)}% sure</span></td>
                    <td>{c.meaning ? titleCase(c.meaning) : <span className="text-ink-3">—</span>}</td>
                    <td className={clsx("num text-right", c.missingPct > 20 && "text-warn")}>{c.missingPct.toFixed(1)}%</td>
                    <td className="num text-right">{formatNumber(c.distinct)}</td>
                    {canEdit && <td><input type="checkbox" aria-label={`Exclude ${c.name}`} checked={exSet.has(c.name)} disabled={busy} onChange={(e) => setExcluded((cur) => { const s = new Set(cur ?? current.excludeColumns); if (e.target.checked) s.add(c.name); else s.delete(c.name); return [...s]; })} className="h-4 w-4 accent-[rgb(var(--thread))]" /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {cols.length > 12 && <button className="w-full border-t border-line py-2 text-sm text-thread hover:bg-sunk" onClick={() => setShowAllCols((s) => !s)}>{showAllCols ? "Show fewer columns" : `Show all ${cols.length} columns`}</button>}
          </div>
        )}
      </section>

      <section aria-labelledby="ver-h">
        <h2 id="ver-h" className="text-xl">Versions</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">Every change to how the file is read creates a new version. Switching back is instant.</p>
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {(versions.data ?? []).map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <span className="font-medium text-ink">Version {v.version}</span>
              {v.id === dataset.currentVersionId && <Badge tone="thread">In use</Badge>}
              {v.status === "failed" && <Badge tone="bad">Failed</Badge>}
              <span className="text-ink-3">{fmtDateTime(v.createdAt)}</span>
              <span className="num text-ink-2">{v.rowCount != null ? `${formatNumber(v.rowCount)} rows` : ""}</span>
              <span className="text-xs text-ink-3">{[v.options.removeDuplicates && "duplicates removed", v.options.normalizeLabels && "labels merged", Object.keys(v.options.dateOrders).length > 0 && "date order set", v.options.excludeColumns.length > 0 && `${v.options.excludeColumns.length} excluded`].filter(Boolean).join(" · ")}</span>
              {canEdit && v.status === "ready" && v.id !== dataset.currentVersionId && <Button size="sm" className="ml-auto" loading={m.activateVersion.isPending} onClick={() => m.activateVersion.mutate({ id: dsId, versionId: v.id }, { onSuccess: () => toast.success(`Version ${v.version} is now in use.`) })}>Use this version</Button>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
