import type { Fact, Provenance } from "../../lib/types";
import { titleCase } from "../../lib/format";

const fmtParam = (v: unknown): string => (Array.isArray(v) ? v.map(fmtParam).join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v));

/** Where a number came from: the calculation, its inputs and its limits. The same panel is used everywhere a figure appears. */
export function ProvenancePanel({ provenance, facts, compact }: { provenance: Provenance; facts?: Fact[]; compact?: boolean }) {
  const params = Object.entries(provenance.params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
      <dt className="text-ink-3">Calculation</dt>
      <dd className="text-ink">{provenance.method}</dd>
      <dt className="text-ink-3">Tool</dt>
      <dd className="text-ink"><code className="rounded bg-sunk px-1 py-0.5 text-[11px]">{provenance.tool}</code></dd>
      {params.length > 0 && <><dt className="text-ink-3">Inputs</dt><dd className="text-ink">{params.map(([k, v]) => `${titleCase(k)}: ${fmtParam(v)}`).join(" · ")}</dd></>}
      <dt className="text-ink-3">Rows used</dt>
      <dd className="num text-ink">{provenance.rowsConsidered.toLocaleString("en-US")}{provenance.filters.length > 0 && <span className="text-ink-2"> after {provenance.filters.join("; ")}</span>}</dd>
      {provenance.period && <><dt className="text-ink-3">Period</dt><dd className="text-ink">{provenance.period.from} to {provenance.period.to}</dd></>}
      {provenance.caveats.length > 0 && <><dt className="text-ink-3">Caveats</dt><dd className="text-ink-2">{provenance.caveats.join(" ")}</dd></>}
      {!compact && facts && facts.length > 0 && (
        <>
          <dt className="text-ink-3">Figures</dt>
          <dd>
            <ul className="grid gap-x-6 sm:grid-cols-2">
              {facts.slice(0, 24).map((f) => <li key={f.id} className="flex justify-between gap-3 border-b border-line py-0.5"><span className="truncate text-ink-2" title={f.label}>{f.label}</span><span className="num text-ink">{f.display}</span></li>)}
            </ul>
            {facts.length > 24 && <p className="mt-1 text-ink-3">and {facts.length - 24} more</p>}
          </dd>
        </>
      )}
    </dl>
  );
}

export function ProvenanceDisclosure({ provenance, facts, label = "How this was calculated" }: { provenance: Provenance; facts?: Fact[]; label?: string }) {
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer select-none text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden"><span className="underline underline-offset-2">{label}</span></summary>
      <div className="mt-2 rounded-md bg-sunk p-3"><ProvenancePanel provenance={provenance} facts={facts} /></div>
    </details>
  );
}
