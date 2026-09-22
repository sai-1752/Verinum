// Creates a clean database for the end-to-end run, applies every migration, and clears file-based state
// (mail outbox, uploaded files). Runs before the API server starts.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const owner = process.env.E2E_DB_OWNER_URL ?? "postgres://verinum_owner:owner_dev_pw@127.0.0.1:5432/verinum_e2e";
const name = new URL(owner).pathname.slice(1);
const admin = new URL(owner);
admin.pathname = "/postgres";

const c = new pg.Client({ connectionString: admin.toString() });
await c.connect();
await c.query(`drop database if exists ${name} with (force)`);
await c.query(`create database ${name}`);
await c.end();

execFileSync(process.execPath, [resolve(root, "apps/api/dist/migrate.mjs")], {
  stdio: "inherit", env: { ...process.env, DATABASE_MIGRATION_URL: owner },
});

for (const dir of [".outbox", ".storage"]) { rmSync(resolve(root, "e2e", dir), { recursive: true, force: true }); mkdirSync(resolve(root, "e2e", dir), { recursive: true }); }
console.log(`e2e database "${name}" is ready`);
