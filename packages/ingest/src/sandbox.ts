/** Runs the legacy-.xls parser in a resource-limited worker thread and terminates it on timeout. */
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { IngestError, type IngestLimits } from "./types";
import type { XlsOut } from "./xls-worker";

function workerFile(): URL {
  for (const n of ["./xls-worker.mjs", "../dist/xls-worker.mjs"]) { const u = new URL(n, import.meta.url); if (existsSync(fileURLToPath(u))) return u; }
  return new URL("./xls-worker.ts", import.meta.url);
}

export function readXlsSandboxed(bytes: Uint8Array, limits: IngestLimits, workerUrl?: URL): Promise<Extract<XlsOut, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(bytes); // the worker gets its own copy; the caller's buffer stays usable
    const worker = new Worker(workerUrl ?? workerFile(), {
      workerData: { bytes: copy, maxRows: limits.maxRows, maxColumns: limits.maxColumns, maxSheets: limits.maxSheets },
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
      env: {}, // nothing from the parent's environment (no secrets) is visible in the sandbox
      stdout: true, stderr: true,
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new IngestError("timeout", "Reading the Excel file took too long.")); }, Math.min(limits.timeoutMs, 60_000));
    worker.once("message", (m: XlsOut) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.ok) resolve(m);
      else reject(new IngestError(m.code === "encrypted" ? "encrypted" : "corrupt", m.message, m.code === "encrypted" ? "Remove the password and upload it again." : undefined));
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      const oom = (e as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY";
      reject(new IngestError(oom ? "limit_exceeded" : "corrupt", oom ? "This Excel file is too large or complex to read safely." : "This Excel file couldn't be read."));
    });
    worker.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new IngestError("corrupt", "This Excel file couldn't be read.")); });
  });
}
