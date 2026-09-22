import { RANK_WEIGHTS } from "@verinum/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Insight } from "../../lib/types";
import { Badge } from "../ui";
import { ChartView } from "../charts/ChartView";
import { titleCase } from "../../lib/format";

const FACTOR_LABEL: Record<string, string> = {
  magnitude: "How large the effect is", relevance: "How close to the business's main metric", significance: "Statistical support",
  novelty: "Not a repeat of another finding", confidence: "Data sufficiency", completeness: "How complete the columns are",
};

export function ScoreBreakdown({ insight }: { insight: Insight }) {
  return (
    <div>
      <p className="text-xs text-ink-3">Score {insight.score.toFixed(0)} out of 100: a fixed weighted sum of six factors, each between 0 and 1.</p>
      <ul className="mt-2 space-y-1.5">
        {(Object.keys(RANK_WEIGHTS) as (keyof typeof RANK_WEIGHTS)[]).map((k) => (
          <li key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-xs sm:grid-cols-[14rem_1fr_5.5rem]">
            <span className="text-ink-2">{FACTOR_LABEL[k]}</span>
            <span className="hidden h-1.5 rounded-full bg-sunk sm:block"><span className="block h-full rounded-full bg-thread" style={{ width: `${Math.round(insight.factors[k] * 100)}%` }} /></span>
            <span className="num text-right text-ink-2">{insight.factors[k].toFixed(2)} × {Math.round(RANK_WEIGHTS[k] * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PRIORITY_TONE = { high: "thread", medium: "neutral", low: "neutral" } as const;
const CONF_TONE = { high: "good", medium: "warn", low: "bad" } as const;

export function InsightItem({ insight, askHref, defaultOpen = false, showChart = true }: { insight: Insight; askHref?: (q: string) => string; defaultOpen?: boolean; showChart?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <article className="py-5" aria-labelledby={`ins-${insight.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={PRIORITY_TONE[insight.priority]}>{titleCase(insight.priority)} priority</Badge>
        <Badge tone={CONF_TONE[insight.confidence]}>{titleCase(insight.confidence)} confidence</Badge>
        <span className="caption">{titleCase(insight.category)}</span>
      </div>
      <h3 id={`ins-${insight.id}`} className="mt-2 text-[1.2rem]">{insight.title}</h3>
      <p className="mt-1 max-w-prose text-sm leading-6 text-ink-2">{insight.summary}</p>
      {showChart && insight.chart && <div className="mt-4 max-w-3xl"><ChartView spec={insight.chart} height={220} /></div>}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button className="text-xs font-medium text-thread underline underline-offset-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Hide the working" : "Show the working"}</button>
        {askHref && insight.followUps.slice(0, 2).map((q) => <Link key={q} to={askHref(q)} className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink">{q}</Link>)}
      </div>
      {open && (
        <div className="mt-3 max-w-3xl space-y-4 rounded-md bg-sunk p-4">
          {insight.detail.length > 0 && <div className="space-y-1.5 text-sm text-ink-2">{insight.detail.map((d, i) => <p key={i}>{d}</p>)}</div>}
          <div><p className="text-xs font-medium text-ink">How it was computed</p><p className="mt-0.5 text-xs text-ink-2">{insight.method}</p></div>
          <ScoreBreakdown insight={insight} />
          {insight.facts.length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink">Figures behind this finding</p>
              <ul className="mt-1 grid gap-x-8 sm:grid-cols-2">
                {insight.facts.map((f) => <li key={f.id} className="flex justify-between gap-3 border-b border-line py-0.5 text-xs"><span className="text-ink-2">{f.label}</span><span className="num text-ink">{f.display}</span></li>)}
              </ul>
            </div>
          )}
          {insight.caveats.length > 0 && <div><p className="text-xs font-medium text-ink">Read this with care</p><ul className="mt-0.5 list-disc pl-4 text-xs text-ink-2">{insight.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
          <p className="text-xs text-ink-3">Reproduce with <code className="rounded bg-panel px-1 py-0.5">{insight.evidence.tool}</code> using {Object.entries(insight.evidence.params).map(([k, v]) => `${k} = ${String(v)}`).join(", ") || "default settings"}.</p>
        </div>
      )}
    </article>
  );
}
