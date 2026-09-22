// Bundles the worker entry points (the API runs ingestion in worker threads that cannot load TypeScript).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const external = ["exceljs", "fflate", "csv-parse", "csv-parse/sync", "fast-xml-parser", "node-html-parser", "pdfjs-dist", "pdfjs-dist/legacy/build/pdf.mjs", "xlsx"];
await build({
  entryPoints: { "worker-entry": join(root, "src/worker-entry.ts"), "xls-worker": join(root, "src/xls-worker.ts") },
  outdir: join(root, "dist"), outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", target: "node20", sourcemap: false, external, logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
