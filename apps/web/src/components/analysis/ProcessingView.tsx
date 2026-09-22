import clsx from "clsx";
import type { JobInfo, Stage } from "../../lib/types";
import { Button } from "../ui";

const DEFAULT_STAGES: Stage[] = [
  { id: "read", label: "Reading the file" }, { id: "extract", label: "Finding the table" }, { id: "clean", label: "Cleaning and standardising" },
  { id: "profile", label: "Understanding each column" }, { id: "quality", label: "Checking data quality" }, { id: "insights", label: "Looking for insights" }, { id: "dashboard", label: "Building the dashboard" },
];

/** Live progress of the processing pipeline: one row per stage, with a plain-language label. */
export function ProcessingView({ job, name, onCancel, cancelling, compact }: { job: JobInfo | null; name: string; onCancel?: () => void; cancelling?: boolean; compact?: boolean }) {
  const stages = job?.stages?.length ? job.stages : DEFAULT_STAGES;
  const idx = job?.progress?.stageIndex ?? (job?.status === "succeeded" ? stages.length : -1);
  const pct = Math.round(job?.progress?.pct ?? 0);
  const queued = !job || job.status === "queued";
  return (
    <section className={clsx("mx-auto max-w-xl", compact ? "py-2" : "py-14")} aria-live="polite" data-testid="processing-view">
      <h2 className="text-2xl">{queued ? "Waiting for a free worker" : "Working through your data"}</h2>
      <p className="mt-1 text-sm text-ink-2">{name}. You can leave this page; it keeps running.</p>
      <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-sunk" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Processing progress">
        <div className="h-full rounded-full bg-thread transition-[width] duration-500" style={{ width: `${Math.max(pct, queued ? 3 : 6)}%` }} />
      </div>
      <p className="num mt-1.5 text-xs text-ink-3">{pct}%{job?.progress?.label ? ` · ${job.progress.label}` : ""}</p>
      <ol className="mt-5 space-y-2.5">
        {stages.map((s, i) => {
          const state = i < idx ? "done" : i === idx ? "active" : "todo";
          return (
            <li key={s.id} className="flex items-center gap-3 text-sm" data-state={state}>
              <span className={clsx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]", state === "done" ? "border-up bg-up text-panel" : state === "active" ? "border-thread" : "border-line-2")} aria-hidden>
                {state === "done" ? "✓" : state === "active" ? <span className="spinner !h-3 !w-3" /> : null}
              </span>
              <span className={clsx(state === "todo" ? "text-ink-3" : "text-ink")}>{s.label}</span>
              <span className="sr-only">{state === "done" ? "done" : state === "active" ? "in progress" : "waiting"}</span>
            </li>
          );
        })}
      </ol>
      {job && job.attempts > 1 && <p className="mt-4 text-xs text-warn">Attempt {job.attempts}: the first try hit a temporary problem and was retried automatically.</p>}
      {onCancel && <Button className="mt-6" size="sm" variant="ghost" onClick={onCancel} loading={cancelling}>Cancel processing</Button>}
    </section>
  );
}
