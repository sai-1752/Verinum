import { parentPort, workerData } from "node:worker_threads";
import { ingestFile, IngestError } from "./index";

async function main() {
  const d = workerData as { bytes: Uint8Array; filename: string; limits?: object; xlsWorkerUrl?: string };
  try {
    const result = await ingestFile(d.bytes, { filename: d.filename, limits: d.limits, xlsWorkerUrl: d.xlsWorkerUrl ? new URL(d.xlsWorkerUrl) : undefined });
    parentPort!.postMessage({ ok: true, result });
  } catch (e) {
    if (e instanceof IngestError) parentPort!.postMessage({ ok: false, code: e.code, message: e.message, hint: e.hint });
    else parentPort!.postMessage({ ok: false, code: "corrupt", message: "This file couldn't be read." });
  }
}
void main();
