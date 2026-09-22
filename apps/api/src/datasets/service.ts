/**
 * Dataset lifecycle: upload → version → queued job → ready; reprocess with new cleaning choices;
 * delete (soft, then a purge job removes stored objects). Every function takes a WorkspaceCtx that
 * came from `resolveWorkspace`, and every query runs in that workspace's RLS scope.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createContext, deserializeFrame, type DatasetProfile } from "@verinum/core";
import { audit } from "../audit";
import type { Deps } from "../context";
import type { Q } from "../db";
import { conflict, notFound, planLimit, unprocessable } from "../errors";
import { enqueue } from "../jobs/queue";
import { appFile } from "../paths";
import { enforce } from "../plans";
import { inWorkspace, isUuid, type WorkspaceCtx } from "../workspaces/service";
import type { ReqMeta } from "../auth/service";
import { estimateFrameBytes, type LoadedDataset } from "./frame-cache";
import { defaultOptions, ProcessOptions } from "./options";

export const DEMO_NAME = "Demo — Retail sales";

/* --------------------------------- shapes ---------------------------------- */

interface VersionRow {
  id: string; dataset_id: string; version: number; status: string; storage_original: string; storage_frame: string | null; byte_size: number;
  row_count: number | null; column_count: number | null; table_index: number; table_name: string | null; available_tables: unknown; options: unknown;
  warnings: unknown; analysis_version: string | null; error: unknown; created_at: Date;
}
interface DatasetRow {
  id: string; name: string; status: string; current_version_id: string | null; source_name: string | null; source_format: string | null; is_demo: boolean;
  created_by: string | null; created_at: Date; updated_at: Date; error: { message?: string } | null;
}

const versionDto = (v: VersionRow) => ({
  id: v.id, version: v.version, status: v.status, rowCount: v.row_count, columnCount: v.column_count, tableIndex: v.table_index, tableName: v.table_name,
  availableTables: v.available_tables, options: v.options, warnings: v.warnings, byteSize: v.byte_size, analysisVersion: v.analysis_version, error: v.error, createdAt: v.created_at,
});

const datasetDto = (d: DatasetRow) => ({
  id: d.id, name: d.name, status: d.status, isDemo: d.is_demo, sourceName: d.source_name, sourceFormat: d.source_format,
  currentVersionId: d.current_version_id, error: d.error?.message ?? null, createdAt: d.created_at, updatedAt: d.updated_at,
});

const DATASET_COLS = "id, name, status, current_version_id, source_name, source_format, is_demo, created_by, created_at, updated_at, error";
const VERSION_COLS = "id, dataset_id, version, status, storage_original, storage_frame, byte_size, row_count, column_count, table_index, table_name, available_tables, options, warnings, analysis_version, error, created_at";

/* --------------------------------- limits ---------------------------------- */

async function usageOf(q: Q): Promise<{ datasets: number; bytes: number }> {
  const r = await q.query<{ datasets: number; bytes: string | null }>(
    `select (select count(*)::int from datasets where status <> 'deleting') as datasets,
            (select coalesce(sum(byte_size), 0) from dataset_versions v join datasets d on d.id = v.dataset_id where d.status <> 'deleting') as bytes`);
  return { datasets: r.rows[0]!.datasets, bytes: Number(r.rows[0]!.bytes ?? 0) };
}

/** Plan limits for a new upload. Reads usage inside the transaction so concurrent uploads can't both slip under. */
async function enforceUploadLimits(q: Q, ctx: WorkspaceCtx, size: number): Promise<void> {
  enforce(ctx.plan, "maxUploadBytes", 0, size, "per upload");
  const u = await usageOf(q);
  enforce(ctx.plan, "maxDatasets", u.datasets, 1, "datasets");
  enforce(ctx.plan, "storageBytes", u.bytes, size, "of stored data");
}

/* --------------------------------- create ---------------------------------- */

interface CreateArgs { filename: string; bytes: Uint8Array; name?: string; isDemo?: boolean; options?: ProcessOptions }

async function create(deps: Deps, ctx: WorkspaceCtx, a: CreateArgs, meta: ReqMeta) {
  const datasetId = randomUUID(), versionId = randomUUID();
  const store = deps.storage.scoped(ctx.workspaceId);
  const originalKey = store.key("datasets", datasetId, "original");
  const options = a.options ?? defaultOptions();
  const displayName = (a.name ?? a.filename.replace(/\.[^.]+$/, "")).trim().slice(0, 200) || "Untitled dataset";

  // Check limits and reserve the rows first; write the object only once the reservation holds.
  const jobId = await inWorkspace(deps, ctx, async (q) => {
    // serialise count-then-insert per workspace so two concurrent uploads can't both slip under a limit
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`datasets:${ctx.workspaceId}`]);
    if (!a.isDemo) await enforceUploadLimits(q, ctx, a.bytes.length);
    else enforce(ctx.plan, "maxDatasets", (await usageOf(q)).datasets, 1, "datasets");
    await q.query(
      "insert into datasets (id, workspace_id, name, status, source_name, source_format, is_demo, created_by) values ($1,$2,$3,'queued',$4,null,$5,$6)",
      [datasetId, ctx.workspaceId, displayName, a.filename.slice(0, 255), a.isDemo ?? false, ctx.userId]);
    await q.query(
      "insert into dataset_versions (id, workspace_id, dataset_id, version, storage_original, byte_size, options, created_by) values ($1,$2,$3,1,$4,$5,$6,$7)",
      [versionId, ctx.workspaceId, datasetId, originalKey, a.bytes.length, JSON.stringify(options), ctx.userId]);
    const id = await enqueue(q, { workspaceId: ctx.workspaceId, kind: "dataset.process", payload: { datasetId, versionId }, createdBy: ctx.userId });
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: a.isDemo ? "dataset.create_demo" : "dataset.upload", targetType: "dataset", targetId: datasetId, meta: { bytes: a.bytes.length, format: a.filename.split(".").pop()?.toLowerCase().slice(0, 8) }, ip: meta.ip, requestId: meta.requestId });
    return id;
  });
  try {
    await store.put(originalKey, a.bytes);
  } catch (e) {
    await inWorkspace(deps, ctx, (q) => q.query("delete from datasets where id = $1", [datasetId])).catch(() => undefined);
    throw e;
  }
  deps.metrics.inc("datasets_created_total", { demo: String(a.isDemo ?? false) });
  return { datasetId, versionId, jobId };
}

export const createFromUpload = (deps: Deps, ctx: WorkspaceCtx, a: { filename: string; bytes: Uint8Array; name?: string }, meta: ReqMeta) =>
  create(deps, ctx, a, meta);

export async function createDemo(deps: Deps, ctx: WorkspaceCtx, meta: ReqMeta) {
  const path = deps.config.DEMO_DATASET_PATH ?? appFile("assets", "demo-retail-sales.csv");
  const bytes = new Uint8Array(await readFile(path));
  const existing = await inWorkspace(deps, ctx, async (q) => (await q.query<{ id: string }>("select id from datasets where is_demo and status <> 'deleting' limit 1")).rows[0]);
  if (existing) throw conflict("The demo dataset is already in this workspace.", "demo_exists");
  return create(deps, ctx, { filename: "demo-retail-sales.csv", bytes, name: DEMO_NAME, isDemo: true }, meta);
}

/* ---------------------------------- read ----------------------------------- */

export async function listDatasets(deps: Deps, ctx: WorkspaceCtx) {
  return inWorkspace(deps, ctx, async (q) => {
    const r = await q.query<DatasetRow & { row_count: number | null; column_count: number | null; quality_score: number | null; progress: Record<string, unknown> | null }>(
      `select d.${DATASET_COLS.split(", ").join(", d.")}, v.row_count, v.column_count, (v.profile #>> '{quality,score}')::int as quality_score,
              (select j.progress from jobs j where j.kind = 'dataset.process' and j.payload ->> 'versionId' = d.current_version_id::text order by j.created_at desc limit 1) as progress
       from datasets d left join dataset_versions v on v.id = d.current_version_id
       where d.status <> 'deleting' order by d.created_at desc`);
    return r.rows.map((d) => ({ ...datasetDto(d), rowCount: d.row_count, columnCount: d.column_count, qualityScore: d.quality_score }));
  });
}

async function loadDatasetRow(q: Q, id: string): Promise<DatasetRow> {
  if (!isUuid(id)) throw notFound("Dataset");
  const d = (await q.query<DatasetRow>(`select ${DATASET_COLS} from datasets where id = $1 and status <> 'deleting'`, [id])).rows[0];
  if (!d) throw notFound("Dataset");
  return d;
}

async function latestVersion(q: Q, datasetId: string, versionId?: string | null): Promise<VersionRow | undefined> {
  if (versionId) return (await q.query<VersionRow>(`select ${VERSION_COLS} from dataset_versions where id = $1 and dataset_id = $2`, [versionId, datasetId])).rows[0];
  return (await q.query<VersionRow>(`select ${VERSION_COLS} from dataset_versions where dataset_id = $1 order by version desc limit 1`, [datasetId])).rows[0];
}

export async function getDataset(deps: Deps, ctx: WorkspaceCtx, id: string) {
  return inWorkspace(deps, ctx, async (q) => {
    const d = await loadDatasetRow(q, id);
    // The version being worked on (may be newer than current_version_id while reprocessing)
    const latest = await latestVersion(q, id);
    const current = d.current_version_id ? await latestVersion(q, id, d.current_version_id) : undefined;
    let job: { status: string; progress: unknown; error: string | null } | null = null;
    if (latest && latest.status === "processing") {
      job = (await q.query<{ status: string; progress: unknown; error: string | null }>(
        "select status, progress, error from jobs where kind = 'dataset.process' and payload ->> 'versionId' = $1 order by created_at desc limit 1", [latest.id])).rows[0] ?? null;
      // a job that ended without updating the version (worker crash, cancel) must not leave the dataset "processing" forever
      if (job && (job.status === "failed" || job.status === "cancelled")) {
        const message = job.error ?? "Processing did not complete.";
        await q.query("update dataset_versions set status = 'failed', error = $2 where id = $1 and status = 'processing'", [latest.id, JSON.stringify({ message })]);
        if (!current) await q.query("update datasets set status = 'failed', error = $2, updated_at = now() where id = $1", [id, JSON.stringify({ message })]);
        else await q.query("update datasets set status = 'ready', updated_at = now() where id = $1", [id]);
        latest.status = "failed"; latest.error = { message };
        d.status = current ? "ready" : "failed"; d.error = current ? null : { message };
      }
    }
    return { ...datasetDto(d), version: current ? versionDto(current) : null, pending: latest && latest.id !== current?.id ? versionDto(latest) : null, job };
  });
}

export async function listVersions(deps: Deps, ctx: WorkspaceCtx, id: string) {
  return inWorkspace(deps, ctx, async (q) => {
    await loadDatasetRow(q, id);
    return (await q.query<VersionRow>(`select ${VERSION_COLS} from dataset_versions where dataset_id = $1 order by version desc`, [id])).rows.map(versionDto);
  });
}

/** Stored analysis artifacts for one version (profile, quality, insights, plan…). */
export async function getArtifacts(deps: Deps, ctx: WorkspaceCtx, id: string, versionId?: string | null) {
  return inWorkspace(deps, ctx, async (q) => {
    const d = await loadDatasetRow(q, id);
    const v = (await q.query<VersionRow & { profile: DatasetProfile | null; transformations: unknown; suggestions: unknown; insights: unknown; plan: unknown; document: unknown }>(
      `select ${VERSION_COLS}, profile, transformations, suggestions, insights, plan, document from dataset_versions where id = $1 and dataset_id = $2 and status = 'ready'`,
      [versionId ?? d.current_version_id, id])).rows[0];
    if (!v) throw notFound("Analysis");
    return { dataset: datasetDto(d), version: versionDto(v), profile: v.profile!, transformations: v.transformations, suggestions: v.suggestions, insights: v.insights, plan: v.plan, document: v.document };
  });
}

/** Loads (through the cache) the parsed frame and profile of a ready version. */
export async function loadForAnalysis(deps: Deps, ctx: WorkspaceCtx, datasetId: string, versionId?: string | null): Promise<LoadedDataset & { dataset: ReturnType<typeof datasetDto>; version: ReturnType<typeof versionDto> }> {
  const { d, v, profile, plan } = await inWorkspace(deps, ctx, async (q) => {
    const d = await loadDatasetRow(q, datasetId);
    const id = versionId ?? d.current_version_id;
    if (!id || !isUuid(id)) throw unprocessable("This dataset isn't ready yet.", "dataset_not_ready");
    const v = (await q.query<VersionRow & { profile: DatasetProfile; plan: unknown }>(`select ${VERSION_COLS}, profile, plan from dataset_versions where id = $1 and dataset_id = $2 and status = 'ready'`, [id, datasetId])).rows[0];
    if (!v || !v.storage_frame) throw unprocessable("This dataset isn't ready yet.", "dataset_not_ready");
    return { d, v, profile: v.profile, plan: v.plan };
  });
  const store = deps.storage.scoped(ctx.workspaceId);
  const loaded = await deps.frames.get(ctx.workspaceId, v.id, async () => {
    const frame = deserializeFrame(gunzipSync(await store.get(v.storage_frame!)));
    return { versionId: v.id, frame, profile, bytes: estimateFrameBytes(frame), ctx: createContext(frame, profile, { datasetVersion: v.id }), plan };
  });
  return { ...loaded, dataset: datasetDto(d), version: versionDto(v) };
}

/* -------------------------------- mutations -------------------------------- */

export async function renameDataset(deps: Deps, ctx: WorkspaceCtx, id: string, name: string, meta: ReqMeta) {
  await inWorkspace(deps, ctx, async (q) => {
    await loadDatasetRow(q, id);
    await q.query("update datasets set name = $2, updated_at = now() where id = $1", [id, name]);
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "dataset.rename", targetType: "dataset", targetId: id, ip: meta.ip, requestId: meta.requestId });
  });
}

/** New version of the same source file with different cleaning choices. The original is never modified. */
export async function reprocess(deps: Deps, ctx: WorkspaceCtx, id: string, options: ProcessOptions, meta: ReqMeta) {
  return inWorkspace(deps, ctx, async (q) => {
    const d = await loadDatasetRow(q, id);
    const latest = await latestVersion(q, id);
    if (!latest) throw notFound("Dataset");
    if (latest.status === "processing") throw conflict("This dataset is still being processed.", "still_processing");
    const versionId = randomUUID();
    await q.query(
      "insert into dataset_versions (id, workspace_id, dataset_id, version, storage_original, byte_size, options, created_by) values ($1,$2,$3,$4,$5,0,$6,$7)",
      [versionId, ctx.workspaceId, id, latest.version + 1, latest.storage_original, JSON.stringify(options), ctx.userId]);
    await q.query("update datasets set status = case when current_version_id is null then 'queued'::dataset_status else status end, updated_at = now() where id = $1", [id]);
    const jobId = await enqueue(q, { workspaceId: ctx.workspaceId, kind: "dataset.process", payload: { datasetId: id, versionId }, createdBy: ctx.userId });
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "dataset.reprocess", targetType: "dataset", targetId: d.id, meta: { version: latest.version + 1 }, ip: meta.ip, requestId: meta.requestId });
    return { versionId, jobId, version: latest.version + 1 };
  });
}

/** Switch the dataset's current version back to an earlier ready version. */
export async function setCurrentVersion(deps: Deps, ctx: WorkspaceCtx, id: string, versionId: string, meta: ReqMeta) {
  if (!isUuid(versionId)) throw notFound("Version");
  await inWorkspace(deps, ctx, async (q) => {
    await loadDatasetRow(q, id);
    const v = await latestVersion(q, id, versionId);
    if (!v || v.status !== "ready") throw notFound("Version");
    await q.query("update datasets set current_version_id = $2, updated_at = now() where id = $1", [id, versionId]);
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "dataset.set_version", targetType: "dataset", targetId: id, meta: { version: v.version }, ip: meta.ip, requestId: meta.requestId });
  });
}

/** Soft-deletes immediately (hidden everywhere) and queues the purge of stored files. */
export async function deleteDataset(deps: Deps, ctx: WorkspaceCtx, id: string, meta: ReqMeta) {
  await inWorkspace(deps, ctx, async (q) => {
    const d = await loadDatasetRow(q, id);
    await q.query("update datasets set status = 'deleting', updated_at = now() where id = $1", [id]);
    const open = await q.query<{ id: string }>("select id from jobs where status in ('queued','running') and kind = 'dataset.process' and payload ->> 'datasetId' = $1", [id]);
    for (const j of open.rows) await q.query("select job_cancel($1)", [j.id]);
    await enqueue(q, { workspaceId: ctx.workspaceId, kind: "dataset.purge", payload: { datasetId: id }, createdBy: ctx.userId, dedupeKey: `purge:${id}`, maxAttempts: 8 });
    await audit(q, { workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "dataset.delete", targetType: "dataset", targetId: id, meta: { name: d.name }, ip: meta.ip, requestId: meta.requestId });
  });
  deps.frames.evictWorkspace(ctx.workspaceId);
}

export { planLimit };
