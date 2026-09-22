import type { Q } from "./db";

export interface AuditEntry {
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
}

/** Appends to the immutable audit trail. `meta` must never hold secrets or dataset content. */
export async function audit(q: Q, e: AuditEntry): Promise<void> {
  await q.query(
    "insert into audit_logs (workspace_id, actor_id, action, target_type, target_id, meta, ip, request_id) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [e.workspaceId ?? null, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.meta ?? {}), e.ip ?? null, e.requestId ?? null],
  );
}
