import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import type { LlmProvider } from "@verinum/core";
import { buildApp } from "../../src/app";
import { loadConfig, type Config } from "../../src/config";
import type { Deps } from "../../src/context";
import { buildDeps } from "../../src/deps";
import { migrate } from "../../src/db/migrate";
import { datasetHandlers } from "../../src/jobs/handlers";
import { JobWorker } from "../../src/jobs/queue";
import { MemoryMailer } from "../../src/mail";

export const OWNER_URL = process.env.TEST_DATABASE_MIGRATION_URL ?? "postgres://verinum_owner:owner_dev_pw@127.0.0.1:5432/verinum_test";
export const APP_URL = process.env.TEST_DATABASE_URL ?? "postgres://verinum_app:app_dev_pw@127.0.0.1:5432/verinum_test";
const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
export const ORIGIN = "http://localhost:5173";

/** Drops and recreates the schema, then applies every migration. Run once per test file. */
export async function initDb(): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query("drop schema public cascade; create schema public;");
  await c.end();
  await migrate(OWNER_URL, MIGRATIONS);
}

/** Empties every table (as the owner) so tests are independent. */
export async function resetData(): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query("truncate users, workspaces, billing_events, audit_logs restart identity cascade");
  await c.end();
}

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test", DATABASE_URL: APP_URL, DATABASE_MIGRATION_URL: OWNER_URL, MAIL_DRIVER: "memory",
    STORAGE_LOCAL_DIR: mkdtempSync(join(tmpdir(), "tl-storage-")), RATE_LIMIT_GLOBAL_PER_MIN: "100000", RATE_LIMIT_AUTH_PER_MIN: "100000",
    WORKER_ENABLED: "false", PUBLIC_WEB_URL: ORIGIN, ...over,
  });
}

export interface TestApp {
  app: FastifyInstance; deps: Deps; worker: JobWorker; mailer: MemoryMailer; config: Config;
  close(): Promise<void>;
}

export async function makeApp(o: { config?: Record<string, string>; ai?: LlmProvider | null; deps?: Partial<Deps> } = {}): Promise<TestApp> {
  const config = testConfig(o.config);
  const mailer = new MemoryMailer();
  const deps = buildDeps(config, { mailer, ai: o.ai ?? null, ...o.deps });
  const app = await buildApp(deps);
  await app.ready();
  const worker = new JobWorker(deps, datasetHandlers(deps));
  return {
    app, deps, worker, mailer, config,
    async close() { await app.close(); await deps.db.close(); rmSync(config.STORAGE_LOCAL_DIR, { recursive: true, force: true }); },
  };
}

/* ------------------------------ HTTP client with a cookie jar ------------------------------ */

export interface Res<T = any> { status: number; body: T; headers: Record<string, any>; raw: string }

export class Client {
  cookies = new Map<string, string>();
  constructor(readonly t: TestApp, readonly origin: string | null = ORIGIN) {}

  private async send(method: string, url: string, payload?: unknown, extra: Record<string, string> = {}, rawPayload?: Buffer): Promise<Res> {
    const headers: Record<string, string> = { ...extra };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.origin) headers.origin = this.origin;
    let body: string | Buffer | undefined = rawPayload;
    if (payload !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(payload); }
    const r = await this.t.app.inject({ method: method as never, url: `/api/v1${url}`, headers, payload: body });
    for (const c of r.cookies) { if (c.value === "" || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name); else this.cookies.set(c.name, c.value); }
    let parsed: unknown = r.body;
    try { parsed = JSON.parse(r.body); } catch { /* not json */ }
    return { status: r.statusCode, body: parsed, headers: r.headers, raw: r.body };
  }

  get = (url: string, headers?: Record<string, string>) => this.send("GET", url, undefined, headers);
  post = (url: string, body?: unknown, headers?: Record<string, string>) => this.send("POST", url, body ?? {}, headers);
  put = (url: string, body?: unknown) => this.send("PUT", url, body ?? {});
  patch = (url: string, body?: unknown) => this.send("PATCH", url, body ?? {});
  delete = (url: string, body?: unknown) => this.send("DELETE", url, body);

  upload(url: string, filename: string, content: Buffer | string, fields: Record<string, string> = {}): Promise<Res> {
    const boundary = "----tlboundary7f3a";
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`));
    return this.send("POST", url, undefined, { "content-type": `multipart/form-data; boundary=${boundary}` }, Buffer.concat(parts));
  }
}

let counter = 0;
export const uniqueEmail = (p = "user") => `${p}${Date.now().toString(36)}${counter++}@example.com`;
export const PASSWORD = "Correct-Horse-Battery-9";

export interface Session { client: Client; email: string; userId: string; workspaceId: string }

export async function signup(t: TestApp, name = "Test User", email = uniqueEmail()): Promise<Session> {
  const client = new Client(t);
  const r = await client.post("/auth/register", { email, password: PASSWORD, name });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${r.raw}`);
  return { client, email, userId: r.body.user.id, workspaceId: r.body.workspaceId };
}

/** Runs queued jobs to completion. */
export const drain = (t: TestApp) => t.worker.drain();

export async function uploadAndProcess(t: TestApp, s: Session, filename: string, content: Buffer | string, fields: Record<string, string> = {}) {
  const r = await s.client.upload(`/workspaces/${s.workspaceId}/datasets`, filename, content, fields);
  if (r.status !== 202) return { upload: r, dataset: null as any };
  await drain(t);
  const d = await s.client.get(`/workspaces/${s.workspaceId}/datasets/${r.body.datasetId}`);
  return { upload: r, dataset: d.body };
}

export async function demoDataset(t: TestApp, s: Session) {
  const r = await s.client.post(`/workspaces/${s.workspaceId}/datasets/demo`);
  if (r.status !== 202) throw new Error(`demo failed: ${r.status} ${r.raw}`);
  await drain(t);
  const d = await s.client.get(`/workspaces/${s.workspaceId}/datasets/${r.body.datasetId}`);
  return { id: r.body.datasetId as string, dataset: d.body };
}

/** Direct SQL as the runtime role (RLS applies), for isolation tests. */
export async function asApp<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: APP_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
export async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Invites a new person to the owner's workspace with `role` and returns their signed-in session. */
export async function addMember(t: TestApp, owner: Session, role: "admin" | "analyst" | "viewer", name = `${role} user`): Promise<Session> {
  const email = uniqueEmail(role);
  const inv = await owner.client.post(`/workspaces/${owner.workspaceId}/invitations`, { email, role });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${inv.raw}`);
  const token = t.mailer.last(email)!.text.match(/token=([\w-]+)/)![1]!;
  const s = await signup(t, name, email);
  const acc = await s.client.post("/invitations/accept", { token });
  if (acc.status !== 200) throw new Error(`accept failed: ${acc.status} ${acc.raw}`);
  return { ...s, workspaceId: owner.workspaceId };
}
