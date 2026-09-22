/**
 * Job queue on Postgres. Enqueue happens inside the caller's tenant transaction (so a job can only
 * be created for a workspace the caller is a verified member of). Workers claim across tenants via
 * SECURITY DEFINER functions, then run each job in *that job's* tenant context, so RLS still applies
 * to everything a job touches.
 */
import { randomUUID } from "node:crypto";
import type { Deps } from "../context";
import type { Q } from "../db";

export interface JobRow {
  id: string; workspace_id: string; kind: string; payload: Record<string, unknown>; status: string; attempts: number; max_attempts: number;
  progress: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; created_by: string | null;
  created_at: Date; finished_at: Date | null;
}

export async function enqueue(q: Q, o: { workspaceId: string; kind: string; payload: Record<string, unknown>; createdBy: string | null; dedupeKey?: string; maxAttempts?: number }): Promise<string> {
  // The runtime role may insert jobs but never update them (state changes go through the definer functions),
  // so de-duplication is insert-or-lookup rather than an upsert.
  const ins = await q.query<{ id: string }>(
    `insert into jobs (workspace_id, kind, payload, created_by, dedupe_key, max_attempts) values ($1,$2,$3,$4,$5,$6)
     on conflict (workspace_id, dedupe_key) where dedupe_key is not null and status in ('queued','running') do nothing returning id`,
    [o.workspaceId, o.kind, JSON.stringify(o.payload), o.createdBy, o.dedupeKey ?? null, o.maxAttempts ?? 3]);
  if (ins.rows[0]) return ins.rows[0].id;
  return (await q.query<{ id: string }>("select id from jobs where workspace_id = $1 and dedupe_key = $2 and status in ('queued','running') limit 1", [o.workspaceId, o.dedupeKey])).rows[0]!.id;
}

export async function getJob(q: Q, id: string): Promise<JobRow | null> {
  const r = await q.query<JobRow>("select id, workspace_id, kind, payload, status, attempts, max_attempts, progress, result, error, created_by, created_at, finished_at from jobs where id = $1", [id]);
  return r.rows[0] ?? null;
}

export interface JobHelpers {
  /** report progress; throws JobCancelled when the job was cancelled or the lease was lost */
  progress(p: Record<string, unknown>): Promise<void>;
  signal: AbortSignal;
}
export type JobHandler = (job: JobRow, h: JobHelpers) => Promise<Record<string, unknown> | void>;
export interface JobDefinition {
  run: JobHandler;
  /** called once when the job has failed for good (no retries left), e.g. to mark a dataset as failed */
  onFailed?: (job: JobRow, userMessage: string) => Promise<void>;
}

export class JobCancelled extends Error { constructor() { super("job cancelled"); this.name = "JobCancelled"; } }
/** Errors that will not succeed on retry (bad input, limit exceeded): fail immediately, don't burn attempts. */
export class PermanentJobError extends Error { constructor(message: string, readonly userMessage: string = message) { super(message); this.name = "PermanentJobError"; } }

export class JobWorker {
  readonly id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private running = 0;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private reaper: NodeJS.Timeout | null = null;
  private inflight = new Set<Promise<void>>();

  constructor(private readonly deps: Deps, private readonly handlers: Record<string, JobDefinition>) {}

  start(): void {
    const { WORKER_POLL_MS } = this.deps.config;
    this.timer = setInterval(() => void this.poll(), WORKER_POLL_MS);
    this.reaper = setInterval(() => void this.reap(), Math.max(10_000, this.deps.config.JOB_LEASE_SECONDS * 250));
    void this.poll();
  }

  async stop(graceMs = 15_000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reaper) clearInterval(this.reaper);
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, graceMs))]);
  }

  private async reap() {
    try {
      const r = await this.deps.db.query<{ job_reap: number }>("select job_reap($1)", [this.deps.config.JOB_LEASE_SECONDS]);
      if (r.rows[0]!.job_reap) this.deps.log.warn({ requeued: r.rows[0]!.job_reap }, "reaped stale jobs");
    } catch (e) { this.deps.log.error({ err: e }, "job reaper failed"); }
  }

  /** Claims and runs jobs until concurrency is full or the queue is empty. Exposed for tests. */
  async poll(): Promise<number> {
    let started = 0;
    while (!this.stopping && this.running < this.deps.config.WORKER_CONCURRENCY) {
      let job: JobRow | undefined;
      try {
        job = (await this.deps.db.query<JobRow>("select * from job_claim($1, $2)", [this.id, Object.keys(this.handlers)])).rows[0];
      } catch (e) { this.deps.log.error({ err: e }, "job claim failed"); return started; }
      if (!job) return started;
      started++;
      this.running++;
      const p = this.run(job).finally(() => { this.running--; this.inflight.delete(p); });
      this.inflight.add(p);
    }
    return started;
  }

  /** Runs everything currently runnable to completion (tests and one-shot tooling). */
  async drain(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await this.poll();
      if (!this.inflight.size) {
        const left = await this.deps.db.query<{ n: number }>("select count(*)::int n from jobs where status = 'queued' and run_at <= now()");
        if (!left.rows[0]!.n) return;
      } else await Promise.allSettled([...this.inflight]);
    }
  }

  private async run(job: JobRow): Promise<void> {
    const { deps } = this;
    const started = Date.now();
    const ac = new AbortController();
    let lost = false;
    const beat = setInterval(async () => {
      try { if (!(await deps.db.query<{ job_heartbeat: boolean }>("select job_heartbeat($1,$2,null)", [job.id, this.id])).rows[0]!.job_heartbeat) { lost = true; ac.abort(); } }
      catch { /* transient; the next beat retries */ }
    }, Math.max(1000, deps.config.JOB_LEASE_SECONDS * 300));
    const handler = this.handlers[job.kind]!.run;
    try {
      const result = await handler(job, {
        signal: ac.signal,
        progress: async (p) => {
          if (lost) throw new JobCancelled();
          const ok = (await deps.db.query<{ job_heartbeat: boolean }>("select job_heartbeat($1,$2,$3)", [job.id, this.id, JSON.stringify(p)])).rows[0]!.job_heartbeat;
          if (!ok) { lost = true; ac.abort(); throw new JobCancelled(); }
        },
      });
      await deps.db.query("select job_finish($1,$2,$3)", [job.id, this.id, JSON.stringify(result ?? {})]);
      deps.metrics.inc("jobs_total", { kind: job.kind, outcome: "succeeded" });
    } catch (e) {
      if (e instanceof JobCancelled || lost) { deps.metrics.inc("jobs_total", { kind: job.kind, outcome: "cancelled" }); }
      else {
        const permanent = e instanceof PermanentJobError;
        const message = e instanceof PermanentJobError ? e.userMessage : "Processing failed unexpectedly.";
        if (!permanent) deps.log.error({ err: e, jobId: job.id, kind: job.kind }, "job failed");
        const outcome = (await deps.db.query<{ job_fail: string }>("select job_fail($1,$2,$3,$4)", [job.id, this.id, message, !permanent])).rows[0]!.job_fail;
        deps.metrics.inc("jobs_total", { kind: job.kind, outcome });
        if (outcome === "failed") await this.onFinalFailure(job, message);
      }
    } finally {
      clearInterval(beat);
      deps.metrics.observe("job_duration_seconds", (Date.now() - started) / 1000, { kind: job.kind });
    }
  }

  private async onFinalFailure(job: JobRow, message: string) {
    try { await this.handlers[job.kind]?.onFailed?.(job, message); } catch (e) { this.deps.log.error({ err: e, jobId: job.id }, "job failure hook failed"); }
  }
}
