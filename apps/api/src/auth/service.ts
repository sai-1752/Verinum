import type { Deps, AuthUser } from "../context";
import type { Q } from "../db";
import { conflict, forbidden, unauthorized, unprocessable } from "../errors";
import { hashPassword, normalizeEmail, passwordProblem, randomToken, sha256, verifyPassword } from "../security/crypto";
import { templates } from "../mail";
import { audit } from "../audit";
import { createWorkspace } from "../workspaces/service";

interface UserRow {
  id: string; email: string; name: string; password_hash: string | null; email_verified_at: Date | null;
  is_platform_admin: boolean; disabled_at: Date | null; failed_logins: number; locked_until: Date | null;
}

const toAuthUser = (r: Pick<UserRow, "id" | "email" | "name" | "email_verified_at" | "is_platform_admin">): AuthUser => ({
  id: r.id, email: r.email, name: r.name, emailVerified: !!r.email_verified_at, isPlatformAdmin: r.is_platform_admin,
});

export const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const VERIFY_TTL_H = 24;
const RESET_TTL_H = 1;

export interface ReqMeta { ip?: string | null; userAgent?: string | null; requestId?: string | null }

/* --------------------------------- sessions --------------------------------- */

export async function createSession(deps: Deps, userId: string, meta: ReqMeta): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(deps.now().getTime() + deps.config.SESSION_TTL_DAYS * 86_400_000);
  await deps.db.query("insert into sessions (user_id, token_hash, expires_at, ip, user_agent) values ($1,$2,$3,$4,$5)", [userId, sha256(token), expiresAt, meta.ip ?? null, (meta.userAgent ?? "").slice(0, 300)]);
  return { token, expiresAt };
}

export async function resolveSession(deps: Deps, token: string): Promise<{ user: AuthUser; sessionId: string } | null> {
  const r = await deps.db.query<UserRow & { sid: string; last_seen_at: Date }>(
    `select u.id, u.email, u.name, u.password_hash, u.email_verified_at, u.is_platform_admin, u.disabled_at, u.failed_logins, u.locked_until, s.id as sid, s.last_seen_at
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`, [sha256(token)]);
  const row = r.rows[0];
  if (!row || row.disabled_at) return null;
  // rolling expiry, written at most every 5 minutes
  if (deps.now().getTime() - row.last_seen_at.getTime() > 300_000) {
    await deps.db.query("update sessions set last_seen_at = now(), expires_at = now() + make_interval(days => $2) where id = $1", [row.sid, deps.config.SESSION_TTL_DAYS]);
  }
  return { user: toAuthUser(row), sessionId: row.sid };
}

export async function revokeSession(deps: Deps, sessionId: string, userId: string): Promise<boolean> {
  const r = await deps.db.query("update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [sessionId, userId]);
  return (r.rowCount ?? 0) > 0;
}
export async function revokeAllSessions(q: Q, userId: string, exceptSessionId?: string): Promise<void> {
  await q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2)", [userId, exceptSessionId ?? null]);
}

export async function listSessions(deps: Deps, userId: string) {
  const r = await deps.db.query<{ id: string; created_at: Date; last_seen_at: Date; ip: string | null; user_agent: string | null }>(
    "select id, created_at, last_seen_at, ip, user_agent from sessions where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc", [userId]);
  return r.rows.map((s) => ({ id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent }));
}

/* ------------------------------ registration ------------------------------- */

export async function register(deps: Deps, input: { email: string; password: string; name: string }, meta: ReqMeta): Promise<{ user: AuthUser; workspaceId: string; session: { token: string; expiresAt: Date } }> {
  if (!deps.config.ALLOW_REGISTRATION) throw forbidden("Sign-ups are currently closed.");
  const email = normalizeEmail(input.email);
  const problem = passwordProblem(input.password, email);
  if (problem) throw unprocessable(problem, "weak_password");
  const hash = await hashPassword(input.password);
  let row: UserRow;
  try {
    row = (await deps.db.query<UserRow>("insert into users (email, password_hash, name) values ($1,$2,$3) returning *", [email, hash, input.name.trim().slice(0, 120)])).rows[0]!;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("An account with this email already exists. Try signing in.", "email_taken");
    throw e;
  }
  const ws = await createWorkspace(deps, row.id, `${input.name.trim().split(" ")[0] || "My"}'s workspace`);
  await sendVerification(deps, row.id, row.email, row.name);
  const session = await createSession(deps, row.id, meta);
  await audit(deps.db, { actorId: row.id, action: "auth.register", meta: {}, ip: meta.ip, requestId: meta.requestId });
  return { user: toAuthUser(row), workspaceId: ws.id, session };
}

/* ---------------------------------- login ---------------------------------- */

export async function login(deps: Deps, emailIn: string, password: string, meta: ReqMeta): Promise<{ user: AuthUser; session: { token: string; expiresAt: Date } }> {
  const email = normalizeEmail(emailIn);
  const row = (await deps.db.query<UserRow>("select * from users where email = $1", [email])).rows[0];
  if (row?.locked_until && row.locked_until > deps.now()) {
    await verifyPassword(password, null); // keep timing uniform
    throw unauthorized("Too many failed attempts. Try again in a few minutes, or reset your password.");
  }
  const ok = await verifyPassword(password, row?.password_hash ?? null);
  if (!row || !ok) {
    if (row) {
      const locked = row.failed_logins + 1 >= MAX_FAILED_LOGINS;
      await deps.db.query("update users set failed_logins = failed_logins + 1, locked_until = case when $2 then now() + make_interval(mins => $3) else locked_until end where id = $1", [row.id, locked, LOCK_MINUTES]);
      if (locked) await audit(deps.db, { actorId: row.id, action: "auth.locked", ip: meta.ip, requestId: meta.requestId });
    }
    throw unauthorized("Invalid email or password.");
  }
  if (row.disabled_at) throw forbidden("This account has been disabled. Contact support.");
  await deps.db.query("update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1", [row.id]);
  const session = await createSession(deps, row.id, meta);
  await audit(deps.db, { actorId: row.id, action: "auth.login", ip: meta.ip, requestId: meta.requestId });
  return { user: toAuthUser(row), session };
}

/* ------------------------- email verification / reset ------------------------ */

async function issueToken(q: Q, userId: string, kind: "verify" | "reset", ttlHours: number): Promise<string> {
  const token = randomToken(32);
  await q.query("update email_tokens set used_at = now() where user_id = $1 and kind = $2 and used_at is null", [userId, kind]); // one live token per kind
  await q.query("insert into email_tokens (user_id, kind, token_hash, expires_at) values ($1,$2,$3, now() + make_interval(hours => $4))", [userId, kind, sha256(token), ttlHours]);
  return token;
}

export async function sendVerification(deps: Deps, userId: string, email: string, name: string): Promise<void> {
  const token = await issueToken(deps.db, userId, "verify", VERIFY_TTL_H);
  await deps.mailer.send({ to: email, ...templates.verifyEmail(name, `${deps.config.PUBLIC_WEB_URL}/verify-email?token=${token}`) });
}

async function consumeToken(q: Q, token: string, kind: "verify" | "reset"): Promise<string | null> {
  const r = await q.query<{ user_id: string }>("update email_tokens set used_at = now() where token_hash = $1 and kind = $2 and used_at is null and expires_at > now() returning user_id", [sha256(token), kind]);
  return r.rows[0]?.user_id ?? null;
}

export async function verifyEmail(deps: Deps, token: string, meta: ReqMeta): Promise<void> {
  const userId = await consumeToken(deps.db, token, "verify");
  if (!userId) throw unprocessable("This verification link is invalid or has expired.", "invalid_token");
  await deps.db.query("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1", [userId]);
  await audit(deps.db, { actorId: userId, action: "auth.email_verified", ip: meta.ip, requestId: meta.requestId });
}

/** Always resolves the same way whether or not the account exists (no account enumeration). */
export async function requestPasswordReset(deps: Deps, emailIn: string, meta: ReqMeta): Promise<void> {
  const row = (await deps.db.query<UserRow>("select * from users where email = $1 and disabled_at is null", [normalizeEmail(emailIn)])).rows[0];
  if (!row) return;
  const token = await issueToken(deps.db, row.id, "reset", RESET_TTL_H);
  await deps.mailer.send({ to: row.email, ...templates.resetPassword(row.name, `${deps.config.PUBLIC_WEB_URL}/reset-password?token=${token}`) });
  await audit(deps.db, { actorId: row.id, action: "auth.reset_requested", ip: meta.ip, requestId: meta.requestId });
}

export async function resetPassword(deps: Deps, token: string, newPassword: string, meta: ReqMeta): Promise<void> {
  const peek = await deps.db.query<{ user_id: string; email: string }>(
    "select t.user_id, u.email from email_tokens t join users u on u.id = t.user_id where t.token_hash = $1 and t.kind = 'reset' and t.used_at is null and t.expires_at > now()", [sha256(token)]);
  if (!peek.rows[0]) throw unprocessable("This reset link is invalid or has expired.", "invalid_token");
  const problem = passwordProblem(newPassword, peek.rows[0].email);
  if (problem) throw unprocessable(problem, "weak_password");
  const hash = await hashPassword(newPassword);
  const userId = await consumeToken(deps.db, token, "reset");
  if (!userId) throw unprocessable("This reset link is invalid or has expired.", "invalid_token");
  await deps.db.query("update users set password_hash = $2, failed_logins = 0, locked_until = null, email_verified_at = coalesce(email_verified_at, now()) where id = $1", [userId, hash]);
  await revokeAllSessions(deps.db, userId); // a reset signs every device out
  await audit(deps.db, { actorId: userId, action: "auth.password_reset", ip: meta.ip, requestId: meta.requestId });
}

export async function changePassword(deps: Deps, userId: string, sessionId: string, current: string, next: string, meta: ReqMeta): Promise<void> {
  const row = (await deps.db.query<UserRow>("select * from users where id = $1", [userId])).rows[0];
  if (!row || !(await verifyPassword(current, row.password_hash))) throw unauthorized("Your current password is incorrect.");
  const problem = passwordProblem(next, row.email);
  if (problem) throw unprocessable(problem, "weak_password");
  await deps.db.query("update users set password_hash = $2 where id = $1", [userId, await hashPassword(next)]);
  await revokeAllSessions(deps.db, userId, sessionId);
  await audit(deps.db, { actorId: userId, action: "auth.password_changed", ip: meta.ip, requestId: meta.requestId });
}

/* ---------------------------------- OAuth ---------------------------------- */

export interface OAuthProfile { provider: string; subject: string; email: string; emailVerified: boolean; name: string }

/** Signs in (or up) a user from a verified OAuth profile. Never trusts an unverified provider email. */
export async function signInWithOAuth(deps: Deps, p: OAuthProfile, meta: ReqMeta): Promise<{ user: AuthUser; session: { token: string; expiresAt: Date }; created: boolean }> {
  if (!p.emailVerified) throw unprocessable("Your provider hasn't verified this email address, so we can't sign you in with it.", "email_not_verified");
  const email = normalizeEmail(p.email);
  let created = false;
  let row: UserRow | undefined;
  const linked = (await deps.db.query<UserRow>("select u.* from oauth_identities i join users u on u.id = i.user_id where i.provider = $1 and i.subject = $2", [p.provider, p.subject])).rows[0];
  if (linked) row = linked;
  else {
    const existing = (await deps.db.query<UserRow>("select * from users where email = $1", [email])).rows[0];
    if (existing) {
      // Pre-hijacking guard: an existing account whose email was never verified may belong to an attacker
      // who registered the victim's address. Verifying via the provider proves ownership, so the password
      // and every session on that account are discarded before linking.
      if (!existing.email_verified_at) {
        await deps.db.query("update users set password_hash = null, email_verified_at = now() where id = $1", [existing.id]);
        await revokeAllSessions(deps.db, existing.id);
        existing.password_hash = null; existing.email_verified_at = new Date();
      }
      row = existing;
    } else {
      row = (await deps.db.query<UserRow>("insert into users (email, name, email_verified_at) values ($1,$2, now()) returning *", [email, (p.name || email.split("@")[0]!).slice(0, 120)])).rows[0]!;
      created = true;
    }
    await deps.db.query("insert into oauth_identities (provider, subject, user_id, email) values ($1,$2,$3,$4) on conflict do nothing", [p.provider, p.subject, row.id, email]);
  }
  if (row.disabled_at) throw forbidden("This account has been disabled. Contact support.");
  if (created) await createWorkspace(deps, row.id, `${(row.name || "My").split(" ")[0]}'s workspace`);
  await deps.db.query("update users set last_login_at = now() where id = $1", [row.id]);
  const session = await createSession(deps, row.id, meta);
  await audit(deps.db, { actorId: row.id, action: created ? "auth.register" : "auth.login", meta: { provider: p.provider }, ip: meta.ip, requestId: meta.requestId });
  return { user: toAuthUser(row), session, created };
}

export async function getUser(deps: Deps, id: string): Promise<AuthUser | null> {
  const r = await deps.db.query<UserRow>("select * from users where id = $1 and disabled_at is null", [id]);
  return r.rows[0] ? toAuthUser(r.rows[0]) : null;
}
