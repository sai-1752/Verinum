// Builds the ingest worker bundles once before any test runs (worker threads cannot load .ts files).
import { execFileSync } from "node:child_process";
export default function setup() {
  execFileSync(process.execPath, ["packages/ingest/scripts/build-workers.mjs"], { stdio: "inherit" });
}
