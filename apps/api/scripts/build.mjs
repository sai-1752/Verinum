// Bundles the API into dist/: server.mjs, migrate.mjs, admin.mjs, plus the ingestion worker bundles.
// Third-party packages stay external (installed with `npm ci --omit=dev`); workspace packages are bundled.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workspaceDeps = ["core", "ingest"].flatMap((p) => Object.keys(JSON.parse(readFileSync(join(root, "..", "..", "packages", p, "package.json"), "utf8")).dependencies ?? {}));
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...workspaceDeps]
  .filter((n) => !n.startsWith("@verinum/"))
  .flatMap((n) => [n, `${n}/*`]);
external.push("@aws-sdk/*");

rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync("npm", ["run", "build:workers", "-w", "@verinum/ingest"], { cwd: join(root, "..", ".."), stdio: "inherit" });

await build({
  entryPoints: { server: join(root, "src/server.ts"), migrate: join(root, "src/db/migrate-cli.ts"), admin: join(root, "src/db/admin-cli.ts") },
  outdir: join(root, "dist"), outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: true, external, logLevel: "info",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const ingestDist = join(root, "..", "..", "packages", "ingest", "dist");
mkdirSync(join(root, "dist"), { recursive: true });
for (const f of ["worker-entry.mjs", "xls-worker.mjs"]) copyFileSync(join(ingestDist, f), join(root, "dist", f));
console.log("API bundle written to dist/");
