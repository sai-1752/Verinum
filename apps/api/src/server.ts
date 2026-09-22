import { buildApp } from "./app";
import { loadConfig } from "./config";
import { buildDeps } from "./deps";
import { datasetHandlers } from "./jobs/handlers";
import { JobWorker } from "./jobs/queue";

const config = loadConfig();
const deps = buildDeps(config);
const app = await buildApp(deps);
const worker = config.WORKER_ENABLED ? new JobWorker(deps, datasetHandlers(deps)) : null;

const shutdown = async (signal: string) => {
  deps.log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  try {
    await app.close();          // stop accepting requests, finish in-flight ones
    await worker?.stop(20_000); // let running jobs finish (or be requeued by the reaper)
    await deps.db.close();
  } finally { process.exit(0); }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => deps.log.error({ err: e }, "unhandled rejection"));

await app.listen({ host: config.HOST, port: config.PORT });
worker?.start();
deps.log.info({ port: config.PORT, worker: !!worker, ai: deps.ai?.name ?? "none", storage: config.STORAGE_DRIVER }, "verinum api ready");
