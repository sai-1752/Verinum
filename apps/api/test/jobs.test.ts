import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asOwner, initDb, makeApp, resetData, signup, type TestApp } from "./helpers/harness";
import { enqueue, JobWorker, PermanentJobError, type JobDefinition } from "../src/jobs/queue";

let t: TestApp;
beforeAll(async () => { await initDb(); t = await makeApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetData(); });

const job = async (id: string) => (await asOwner((c) => c.query("select status, attempts, error, result, progress, locked_by from jobs where id = $1", [id]))).rows[0];
const add = async (s: { workspaceId: string; userId: string }, kind: string, extra: Record<string, unknown> = {}) =>
  t.deps.db.tx({ userId: s.userId, workspaceId: s.workspaceId }, (q) => enqueue(q, { workspaceId: s.workspaceId, kind, payload: extra, createdBy: s.userId, ...(extra.__dedupe ? { dedupeKey: String(extra.__dedupe) } : {}) }));

describe("job queue", () => {
  it("runs jobs for different tenants each in its own tenant context, reporting progress and results", async () => {
    const a = await signup(t), b = await signup(t);
    const seen: string[] = [];
    const w = new JobWorker(t.deps, { echo: { run: async (j, h) => {
      await h.progress({ step: 1 });
      // inside the job, RLS scopes queries to the job's own tenant
      const n = await t.deps.db.tx({ userId: j.created_by, workspaceId: j.workspace_id }, async (q) => (await q.query("select count(*)::int n from jobs")).rows[0].n);
      seen.push(`${j.workspace_id}:${n}`);
      return { ok: true };
    } } });
    const ja = await add(a, "echo"), jb = await add(b, "echo");
    await w.drain();
    expect(seen.sort()).toEqual([`${a.workspaceId}:1`, `${b.workspaceId}:1`].sort());
    expect(await job(ja)).toMatchObject({ status: "succeeded", attempts: 1, result: { ok: true }, progress: { step: 1, pct: 100 } });
    expect((await job(jb)).status).toBe("succeeded");
  });

  it("retries transient failures with backoff, then fails permanently after max attempts and runs the failure hook once", async () => {
    const s = await signup(t);
    let runs = 0, hooks = 0;
    const w = new JobWorker(t.deps, { flaky: { run: async () => { runs++; throw new Error("boom: secret internals"); }, onFailed: async (_j, m) => { hooks++; expect(m).not.toMatch(/boom|secret/); } } });
    const id = await add(s, "flaky");
    for (let i = 0; i < 3; i++) {
      await w.poll(); await w.drain().catch(() => undefined);
      await asOwner((c) => c.query("update jobs set run_at = now() where id = $1 and status = 'queued'", [id])); // skip the backoff wait
    }
    await w.poll(); await new Promise((r) => setTimeout(r, 200));
    const j = await job(id);
    expect(runs).toBe(3);
    expect(hooks).toBe(1);
    expect(j).toMatchObject({ status: "failed", attempts: 3 });
    expect(j.error).toBe("Processing failed unexpectedly."); // the user-facing message never contains internals
  });

  it("permanent errors fail immediately without retries and show their user message", async () => {
    const s = await signup(t);
    let runs = 0;
    const w = new JobWorker(t.deps, { bad: { run: async () => { runs++; throw new PermanentJobError("internal detail", "This file has too many rows."); } } });
    const id = await add(s, "bad");
    await w.drain();
    expect(runs).toBe(1);
    expect(await job(id)).toMatchObject({ status: "failed", attempts: 1, error: "This file has too many rows." });
  });

  it("only one worker claims a job (SKIP LOCKED), even under concurrent polling", async () => {
    const s = await signup(t);
    let runs = 0;
    const defs: Record<string, JobDefinition> = { once: { run: async () => { runs++; await new Promise((r) => setTimeout(r, 100)); } } };
    const workers = [0, 1, 2, 3].map(() => new JobWorker(t.deps, defs));
    for (let i = 0; i < 5; i++) await add(s, "once", { i });
    await Promise.all(workers.map((w) => w.poll()));
    await Promise.all(workers.map((w) => w.drain()));
    expect(runs).toBe(5);
    expect((await asOwner((c) => c.query("select count(*)::int n from jobs where status = 'succeeded'"))).rows[0].n).toBe(5);
  });

  it("a crashed worker's job is reclaimed by the reaper after its lease expires, and completes on retry", async () => {
    const s = await signup(t);
    const id = await add(s, "work");
    // simulate a worker that claimed the job and died
    await asOwner((c) => c.query("update jobs set status = 'running', locked_by = 'dead-worker', attempts = 1, heartbeat_at = now() - interval '10 minutes' where id = $1", [id]));
    expect((await t.deps.db.query<{ job_reap: number }>("select job_reap($1)", [120])).rows[0]!.job_reap).toBe(1);
    expect(await job(id)).toMatchObject({ status: "queued", locked_by: null });
    const w = new JobWorker(t.deps, { work: { run: async () => ({ done: 1 }) } });
    await w.drain();
    expect(await job(id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("a job that keeps crashing workers ends up failed instead of looping forever", async () => {
    const s = await signup(t);
    const id = await add(s, "work");
    await asOwner((c) => c.query("update jobs set status = 'running', locked_by = 'dead', attempts = 3, heartbeat_at = now() - interval '10 minutes' where id = $1", [id]));
    await t.deps.db.query("select job_reap(120)");
    expect(await job(id)).toMatchObject({ status: "failed", error: "The worker stopped responding." });
  });

  it("a stale worker cannot finish or fail a job it no longer owns", async () => {
    const s = await signup(t);
    const id = await add(s, "work");
    await asOwner((c) => c.query("update jobs set status = 'running', locked_by = 'new-owner' where id = $1", [id]));
    expect((await t.deps.db.query("select job_finish($1,'stale-worker','{}')", [id])).rows[0].job_finish).toBe(false);
    expect((await t.deps.db.query("select job_fail($1,'stale-worker','x',false)", [id])).rows[0].job_fail).toBe("lost");
    expect((await job(id)).status).toBe("running");
  });

  it("cancelling a running job makes the worker stop at its next progress report", async () => {
    const s = await signup(t);
    let stoppedEarly = false;
    const w = new JobWorker(t.deps, { long: { run: async (j, h) => {
      await h.progress({ step: 1 });
      await t.deps.db.tx({ userId: s.userId, workspaceId: s.workspaceId }, (q) => q.query("select job_cancel($1)", [j.id]));
      try { await h.progress({ step: 2 }); } catch { stoppedEarly = true; throw new Error("cancelled"); }
    } } });
    const id = await add(s, "long");
    await w.drain();
    expect(stoppedEarly).toBe(true);
    expect((await job(id)).status).toBe("cancelled");
  });

  it("de-duplicates by key while a job is open", async () => {
    const s = await signup(t);
    const q = (k: string) => t.deps.db.tx({ userId: s.userId, workspaceId: s.workspaceId }, (c) => enqueue(c, { workspaceId: s.workspaceId, kind: "x", payload: {}, createdBy: s.userId, dedupeKey: k }));
    const a = await q("same"), b = await q("same"), c = await q("other");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("a worker only claims kinds it can handle", async () => {
    const s = await signup(t);
    const id = await add(s, "unhandled-kind");
    await new JobWorker(t.deps, { other: { run: async () => undefined } }).poll();
    expect((await job(id)).status).toBe("queued");
  });
});
