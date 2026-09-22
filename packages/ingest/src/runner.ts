/**
 * Runs `ingestFile` in a worker thread with a memory cap and a hard timeout, so a hostile or huge
 * file can never take down the API process. The worker receives only the bytes and options.
 */
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { IngestError, type IngestResult } from "./types";
import type { IngestOptions } from "./index";

function entry(): URL {
  // bundled next to this file (production), or built into ../dist (dev/test: `npm run build:workers`)
  for (const n of ["./worker-entry.mjs", "../dist/worker-entry.mjs"]) { const u = new URL(n, import.meta.url); if (existsSync(fileURLToPath(u))) return u; }
  return new URL("./worker-entry.ts", import.meta.url);
}

export interface RunnerOptions extends IngestOptions { memoryMb?: number; workerUrl?: URL }

export function ingestInWorker(bytes: Uint8Array, opts: RunnerOptions): Promise<IngestResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.min(opts.limits?.timeoutMs ?? 120_000, 300_000);
    const copy = new Uint8Array(bytes);
    const worker = new Worker(opts.workerUrl ?? entry(), {
      workerData: { bytes: copy, filename: opts.filename, limits: opts.limits, xlsWorkerUrl: opts.xlsWorkerUrl?.href },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: opts.memoryMb ?? 2048, maxYoungGenerationSizeMb: 128, stackSizeMb: 8 },
      env: {},
    });
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); fn(); };
    const timer = setTimeout(() => finish(() => reject(new IngestError("timeout", "Reading this file took too long and was stopped."))), timeoutMs + 5_000);
    worker.once("message", (m: { ok: true; result: IngestResult } | { ok: false; code: string; message: string; hint?: string }) => {
      finish(() => (m.ok ? resolve(m.result) : reject(new IngestError(m.code as never, m.message, m.hint))));
    });
    worker.once("error", (e) => {
      const oom = (e as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY";
      finish(() => reject(new IngestError(oom ? "limit_exceeded" : "corrupt", oom ? "This file is too large or complex to read safely." : "This file couldn't be read.")));
    });
    worker.once("exit", (code) => finish(() => reject(new IngestError("corrupt", code === 0 ? "The reader stopped unexpectedly." : "This file couldn't be read."))));
  });
}
