import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/** Applies pending SQL migrations in order, each in its own transaction, under an advisory lock. */
export async function migrate(databaseUrl: string, dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727274)");
    await client.query("create table if not exists schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now())");
    const done = new Map((await client.query<{ version: string; checksum: string }>("select version, checksum from schema_migrations")).rows.map((r) => [r.version, r.checksum]));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(f);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${f} was modified after it was applied. Add a new migration instead.`);
        continue;
      }
      log(`applying ${f}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version, checksum) values ($1, $2)", [f, checksum]);
        await client.query("commit");
        applied.push(f);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    await client.end();
  }
  return applied;
}
