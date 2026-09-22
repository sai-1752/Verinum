import { IngestError } from "@verinum/ingest";
import { audit } from "../audit";
import type { Deps } from "../context";
import { PermanentJobError, type JobDefinition, type JobRow } from "./queue";
import { ProcessOptions } from "../datasets/options";
import { runPipeline, STAGES, type PipelineResult } from "../datasets/pipeline";
import { enforce } from "../plans";
import { AppError } from "../errors";
import { workspacePlan } from "../usage";


const ingestMessage = (e: IngestError): string => (e.hint ? `${e.message} ${e.hint}` : e.message);

/** Persists a finished pipeline run and flips the dataset to ready, all in one tenant transaction. */
async function persist(deps: Deps, job: JobRow, r: PipelineResult, ids: { datasetId: string; versionId: string; version: number; frameKey: string; sourceFormat: string }) {
  await deps.db.tx({ userId: job.created_by, workspaceId: job.workspace_id }, async (q) => {
    await q.query(
      `update dataset_versions set status = 'ready', storage_frame = $3, row_count = $4, column_count = $5, table_index = $6, table_name = $7,
         available_tables = $8, profile = $9, quality = $10, transformations = $11, suggestions = $12, insights = $13, plan = $14, document = $15,
         warnings = $16, analysis_version = $17, error = null where id = $1 and dataset_id = $2`,
      [ids.versionId, ids.datasetId, ids.frameKey, r.frame.rowCount, r.frame.columns.length, r.tableIndex, r.tableName,
        JSON.stringify(r.availableTables), JSON.stringify(r.profile), JSON.stringify(r.profile.quality), JSON.stringify(r.transformations), JSON.stringify(r.suggestions),
        JSON.stringify(r.insights), JSON.stringify(r.plan), r.document ? JSON.stringify(r.document) : null, JSON.stringify(r.warnings), r.analysisVersion]);
    await q.query("update datasets set status = 'ready', current_version_id = $2, source_format = $3, error = null, updated_at = now() where id = $1", [ids.datasetId, ids.versionId, ids.sourceFormat]);
    await q.query("insert into usage_events (workspace_id, user_id, kind, quantity, meta) values ($1,$2,'dataset_processed',1,$3)",
      [job.workspace_id, job.created_by, JSON.stringify({ rows: r.frame.rowCount, columns: r.frame.columns.length, ms: r.timings })]);
    await audit(q, { workspaceId: job.workspace_id, actorId: job.created_by, action: "dataset.processed", targetType: "dataset", targetId: ids.datasetId, meta: { version: ids.version, rows: r.frame.rowCount } });
  });
}

export function datasetHandlers(deps: Deps): Record<string, JobDefinition> {
  return {
    "dataset.process": {
      async run(job, h) {
        const { datasetId, versionId } = job.payload as { datasetId: string; versionId: string };
        const scope = { userId: job.created_by, workspaceId: job.workspace_id };
        const store = deps.storage.scoped(job.workspace_id);
        const v = await deps.db.tx(scope, async (q) => (await q.query<{ storage_original: string; version: number; options: unknown; status: string }>(
          "select v.storage_original, v.version, v.options, v.status from dataset_versions v join datasets d on d.id = v.dataset_id where v.id = $1 and v.dataset_id = $2 and d.status <> 'deleting'", [versionId, datasetId])).rows[0]);
        if (!v) throw new PermanentJobError("dataset version is gone", "This dataset was deleted.");
        if (v.status === "ready") return { skipped: true };
        await deps.db.tx(scope, (q) => q.query("update datasets set status = case when current_version_id is null then 'processing'::dataset_status else status end where id = $1", [datasetId]));

        const plan = await workspacePlan(deps, job.workspace_id, job.created_by);
        const options = ProcessOptions.parse(v.options);
        const filename = (await deps.db.tx(scope, async (q) => (await q.query<{ source_name: string }>("select source_name from datasets where id = $1", [datasetId])).rows[0]))?.source_name ?? "upload";
        const bytes = await store.get(v.storage_original);

        let result: PipelineResult;
        try {
          result = await runPipeline({
            bytes, filename, options, today: deps.now(), signal: h.signal, memoryMb: deps.config.INGEST_MEMORY_MB,
            limits: { maxBytes: Math.max(plan.limits.maxUploadBytes, bytes.length), ...(plan.limits.maxRowsPerDataset > 0 ? { maxRows: plan.limits.maxRowsPerDataset + 1 } : {}) },
            onStage: (stage, i) => h.progress({ stage, stageIndex: i, stages: STAGES.length, label: STAGES[i]!.label, pct: Math.round((i / STAGES.length) * 100) }),
          });
        } catch (e) {
          if (e instanceof IngestError) throw new PermanentJobError(`ingest: ${e.code}`, ingestMessage(e));
          throw e;
        }
        try { enforce(plan, "maxRowsPerDataset", 0, result.frame.rowCount, "rows per dataset"); }
        catch (e) { if (e instanceof AppError) throw new PermanentJobError("plan row limit", e.message); throw e; }

        const frameKey = store.key("datasets", datasetId, `v${v.version}`, "frame.gz");
        await store.put(frameKey, result.frameBlob);
        await persist(deps, job, result, { datasetId, versionId, version: v.version, frameKey, sourceFormat: result.format });
        deps.frames.evictVersion(job.workspace_id, versionId);
        return { rows: result.frame.rowCount, columns: result.frame.columns.length, ms: result.timings };
      },
      async onFailed(job, message) {
        const { datasetId, versionId } = job.payload as { datasetId: string; versionId: string };
        await deps.db.tx({ userId: job.created_by, workspaceId: job.workspace_id }, async (q) => {
          await q.query("update dataset_versions set status = 'failed', error = $2 where id = $1 and status = 'processing'", [versionId, JSON.stringify({ message })]);
          // A failed first version fails the dataset; a failed reprocess leaves the current version untouched.
          await q.query("update datasets set status = 'failed', error = $2, updated_at = now() where id = $1 and current_version_id is null", [datasetId, JSON.stringify({ message })]);
          await audit(q, { workspaceId: job.workspace_id, actorId: job.created_by, action: "dataset.failed", targetType: "dataset", targetId: datasetId, meta: { reason: message.slice(0, 200) } });
        });
      },
    },

    "dataset.purge": {
      async run(job) {
        const { datasetId } = job.payload as { datasetId: string };
        const store = deps.storage.scoped(job.workspace_id);
        await store.deletePrefix(store.key("datasets", datasetId));
        await deps.db.tx({ userId: job.created_by, workspaceId: job.workspace_id }, async (q) => {
          await q.query("delete from datasets where id = $1 and status = 'deleting'", [datasetId]);
        });
        deps.frames.evictWorkspace(job.workspace_id);
        return { purged: datasetId };
      },
    },
  };
}
