/**
 * Database access. Two entry points, deliberately different:
 *
 *   db.query()        — no tenant context. Only for global identity tables (users, sessions, tokens).
 *                        Tenant tables queried this way return zero rows (RLS fails closed).
 *   db.tx({user, workspace}) — one transaction with `app.user_id` / `app.workspace_id` set for its
 *                        duration (set_config is_local = true, so nothing leaks to the next request).
 *                        A workspace id is only ever obtained from a verified membership.
 */
import pg from "pg";

// Return bigint counts as numbers and keep timestamptz as Date
pg.types.setTypeParser(20, (v) => Number(v));

export interface TenantContext { userId?: string | null; workspaceId?: string | null }

export interface Q {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export class Db implements Q {
  readonly pool: pg.Pool;
  constructor(url: string, max = 20) {
    this.pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", () => { /* idle client errors are surfaced on the next query */ });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(sql, params as never);
  }

  async tx<T>(ctx: TenantContext, fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [ctx.userId ?? "", ctx.workspaceId ?? ""]);
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try { await this.pool.query("select 1"); return true; } catch { return false; }
  }

  close(): Promise<void> { return this.pool.end(); }
}
