import { useState } from "react";
import { ChartView } from "../../components/charts/ChartView";
import { ProvenanceDisclosure } from "../../components/analysis/Provenance";
import { EmptyState, ErrorNote, Field, Notice, QueryError, Select, Skeleton } from "../../components/ui";
import { useForecast, useProfile } from "../../lib/hooks";
import { ApiError } from "../../lib/api";
import { useDatasetCtx } from "./Layout";

interface ForecastData {
  metric: string; grain: string; modelLabel: string; confidence: string; historyPeriods: number;
  backtest: { folds: number; mape: number; compared: { model: string; mape: number }[] };
  points: { period: string; display: string; loDisplay: string; hiDisplay: string }[];
  assumptions: string[]; limitations: string[];
}

export function ForecastPage() {
  const { wsId, dsId, versionId } = useDatasetCtx();
  const profile = useProfile(wsId, dsId, versionId);
  const caps = profile.data?.profile.capabilities;
  const measures = caps?.additiveMeasures?.length ? caps.additiveMeasures : caps?.measures ?? [];
  const [metric, setMetric] = useState<string>("");
  const [horizon, setHorizon] = useState(3);
  const chosen = metric || caps?.leadMetric || measures[0] || "";
  const enabled = !!caps?.forecast && !!chosen;
  const q = useForecast(wsId, dsId, versionId, { metric: chosen, horizon }, enabled);

  if (profile.isLoading) return <Skeleton className="h-96" />;
  if (profile.error) return <QueryError error={profile.error} />;
  if (!caps?.forecast) {
    return (
      <EmptyState title="Not enough history to forecast" className="mx-auto max-w-xl">
        {caps?.unavailable?.forecast ?? "A forecast needs a date column and enough complete periods of history. It stays off until the data can support it, so you never see a projection that isn't earned."}
      </EmptyState>
    );
  }
  const d = q.data?.data as ForecastData | undefined;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-56"><Field label="What to forecast">{(p) => <Select {...p} value={chosen} onChange={(e) => setMetric(e.target.value)}>{measures.map((m) => <option key={m}>{m}</option>)}</Select>}</Field></div>
        <div className="w-40"><Field label="Periods ahead">{(p) => <Select {...p} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>{[1, 2, 3, 4, 6, 9, 12].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field></div>
      </div>

      {q.isLoading && <Skeleton className="mt-6 h-80" />}
      {q.error && <div className="mt-6">{q.error instanceof ApiError && q.error.status === 422 ? <Notice tone="warn" title="This can't be forecast">{q.error.message}</Notice> : <ErrorNote error={q.error} />}</div>}

      {q.data?.chart && d && (
        <div className="mt-6 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <ChartView spec={q.data.chart} height={320} />
            <div className="mt-2"><ProvenanceDisclosure provenance={q.data.provenance} facts={q.data.facts} /></div>
          </div>
          <aside className="space-y-6">
            <div>
              <h2 className="text-lg">Projected values</h2>
              <table className="mt-2 w-full" aria-label="Forecast values">
                <thead className="thead"><tr><th>Period</th><th className="!text-right">Estimate</th><th className="!text-right">Likely range</th></tr></thead>
                <tbody>{d.points.map((p) => <tr key={p.period} className="trow"><td>{p.period}</td><td className="num text-right font-medium">{p.display}</td><td className="num text-right text-ink-2">{p.loDisplay} – {p.hiDisplay}</td></tr>)}</tbody>
              </table>
            </div>
            <div>
              <h2 className="text-lg">How reliable is it?</h2>
              <p className="mt-1 text-sm text-ink-2"><span className="font-medium text-ink">{d.confidence} confidence.</span> {d.modelLabel}, chosen by testing against the last {d.backtest.folds} periods, where its average error was <span className="num">{d.backtest.mape.toFixed(1)}%</span>. Based on <span className="num">{d.historyPeriods}</span> periods of history.</p>
            </div>
          </aside>
        </div>
      )}
      {d && (
        <div className="mt-8 grid gap-8 border-t border-line pt-6 md:grid-cols-2">
          <div><h3 className="text-base">What this assumes</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">{d.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
          <div><h3 className="text-base">Read this with care</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">{d.limitations.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
        </div>
      )}
      {caps.unavailable?.seasonality && <p className="mt-6 text-xs text-ink-3">{caps.unavailable.seasonality}</p>}
    </div>
  );
}
