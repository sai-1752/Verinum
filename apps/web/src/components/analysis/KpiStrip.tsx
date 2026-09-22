import clsx from "clsx";
import type { Kpi } from "../../lib/types";
import { Sparkline } from "./Sparkline";

const COST_LIKE = /cost|spend|marketing|discount|refund|churn|return|expense|defect/i;

function Delta({ kpi }: { kpi: Kpi }) {
  const d = kpi.delta;
  if (!d) return null;
  const inverted = COST_LIKE.test(kpi.label);
  const good = d.direction === "flat" ? null : (d.direction === "up") !== inverted;
  const arrow = d.direction === "up" ? "▲" : d.direction === "down" ? "▼" : "■";
  const text = d.displayPct ?? d.displayAbs;
  return (
    <p className={clsx("num mt-1 text-xs", good === null ? "text-ink-3" : good ? "text-up" : "text-down")}>
      <span aria-hidden className="mr-1 text-[9px]">{arrow}</span>
      <span className="sr-only">{d.direction === "up" ? "Up " : d.direction === "down" ? "Down " : "Flat "}</span>
      {text} <span className="text-ink-3">vs {d.previousPeriod}</span>
    </p>
  );
}

/** The headline figures: a single row separated by rules, not a grid of boxes. */
export function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  if (!kpis.length) return null;
  return (
    <div className="grid grid-cols-2 gap-y-6 border-y border-line py-5 sm:grid-cols-3 lg:grid-cols-6 lg:gap-y-0" role="list" aria-label="Headline figures">
      {kpis.slice(0, 6).map((k, i) => (
        <div key={k.id} role="listitem" className={clsx("min-w-0 px-4 first:pl-0 lg:border-l lg:border-line", i === 0 && "lg:border-l-0")}>
          <p className="truncate text-xs text-ink-3" title={k.label}>{k.label}</p>
          <p className="num mt-1 font-serif text-[1.75rem] leading-none text-ink">{k.display}</p>
          <Delta kpi={k} />
          {k.sparkline.length > 2 && <div className="mt-2"><Sparkline values={k.sparkline} labels={k.sparklineLabels} width={88} height={24} label={`${k.label} by period`} /></div>}
          {k.caveats.length > 0 && (
            <details className="mt-1.5 text-xs">
              <summary className="cursor-pointer text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden"><span className="underline underline-offset-2">Note</span></summary>
              <p className="mt-1 text-ink-2">{k.caveats.join(" ")}</p>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
