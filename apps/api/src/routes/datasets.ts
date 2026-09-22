import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../context";
import { createDemo, createFromUpload, deleteDataset, getDataset, listDatasets, listVersions, renameDataset, reprocess, setCurrentVersion } from "../datasets/service";
import { ProcessOptions } from "../datasets/options";
import { STAGES } from "../datasets/pipeline";
import { badRequest, notFound, planLimit } from "../errors";
import { getJob } from "../jobs/queue";
import { inWorkspace, isUuid, validateName } from "../workspaces/service";
import { metaOf, parse, workspaceFor } from "./util";

/** Filenames are untrusted: keep the base name, drop control characters, cap the length. */
export function cleanFilename(raw: string | undefined): string {
  const base = basename((raw ?? "upload").replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return base || "upload";
}

export async function registerDatasetRoutes(app: FastifyInstance, deps: Deps) {
  const base = "/workspaces/:workspaceId/datasets";
  const uploadLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.get(base, async (req) => ({ datasets: await listDatasets(deps, await workspaceFor(deps, req, "dataset.read")), stages: STAGES }));

  app.post(base, uploadLimit, async (req, reply) => {
    const ctx = await workspaceFor(deps, req, "dataset.create");
    const max = ctx.plan.limits.maxUploadBytes;
    const declared = Number(req.headers["content-length"]);
    // Reject oversized uploads from the header alone, before reading the body
    if (max >= 0 && Number.isFinite(declared) && declared > max + 64 * 1024) {
      throw planLimit("maxUploadBytes", `Your ${ctx.plan.name} plan allows uploads up to ${Math.round(max / 1048576)} MB. Upgrade for larger files.`, { max, plan: ctx.plan.id });
    }
    if (!req.isMultipart()) throw badRequest("Send the file as multipart/form-data with a 'file' field.");
    const file = await req.file();
    if (!file) throw badRequest("No file was attached.");
    const bytes = await file.toBuffer();
    if (!bytes.length) throw badRequest("That file is empty.");
    const nameField = file.fields.name as { value?: unknown } | undefined;
    const name = typeof nameField?.value === "string" && nameField.value.trim() ? validateName(nameField.value, "Dataset name") : undefined;
    const r = await createFromUpload(deps, ctx, { filename: cleanFilename(file.filename), bytes: new Uint8Array(bytes), name }, metaOf(req));
    return reply.status(202).send(r);
  });

  app.post(`${base}/demo`, async (req, reply) => {
    const ctx = await workspaceFor(deps, req, "dataset.create");
    return reply.status(202).send(await createDemo(deps, ctx, metaOf(req)));
  });

  app.get(`${base}/:datasetId`, async (req) => getDataset(deps, await workspaceFor(deps, req, "dataset.read"), (req.params as { datasetId: string }).datasetId));

  app.patch(`${base}/:datasetId`, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.update");
    const body = parse(z.object({ name: z.string() }).strict(), req.body);
    await renameDataset(deps, ctx, (req.params as { datasetId: string }).datasetId, validateName(body.name, "Dataset name"), metaOf(req));
    return { ok: true };
  });

  app.delete(`${base}/:datasetId`, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.delete");
    await deleteDataset(deps, ctx, (req.params as { datasetId: string }).datasetId, metaOf(req));
    return { ok: true };
  });

  app.post(`${base}/:datasetId/reprocess`, async (req, reply) => {
    const ctx = await workspaceFor(deps, req, "dataset.update");
    const options = parse(ProcessOptions, (req.body as { options?: unknown } | undefined)?.options ?? {});
    return reply.status(202).send(await reprocess(deps, ctx, (req.params as { datasetId: string }).datasetId, options, metaOf(req)));
  });

  app.get(`${base}/:datasetId/versions`, async (req) => ({ versions: await listVersions(deps, await workspaceFor(deps, req, "dataset.read"), (req.params as { datasetId: string }).datasetId) }));

  app.post(`${base}/:datasetId/versions/:versionId/activate`, async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.update");
    const p = req.params as { datasetId: string; versionId: string };
    await setCurrentVersion(deps, ctx, p.datasetId, p.versionId, metaOf(req));
    return { ok: true };
  });

  /* ---- jobs (polling) ---- */
  app.get("/workspaces/:workspaceId/jobs/:jobId", async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.read");
    const id = (req.params as { jobId: string }).jobId;
    if (!isUuid(id)) throw notFound("Job");
    const j = await inWorkspace(deps, ctx, (q) => getJob(q, id));
    if (!j) throw notFound("Job");
    return { id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, progress: j.progress, error: j.error, createdAt: j.created_at, finishedAt: j.finished_at, stages: STAGES };
  });

  app.post("/workspaces/:workspaceId/jobs/:jobId/cancel", async (req) => {
    const ctx = await workspaceFor(deps, req, "dataset.update");
    const id = (req.params as { jobId: string }).jobId;
    if (!isUuid(id)) throw notFound("Job");
    const ok = await inWorkspace(deps, ctx, async (q) => (await q.query<{ job_cancel: boolean }>("select job_cancel($1)", [id])).rows[0]!.job_cancel);
    return { cancelled: ok };
  });
}
