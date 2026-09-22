import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  changePassword, getUser, listSessions, login, register, requestPasswordReset, resetPassword, revokeAllSessions, revokeSession,
  sendVerification, signInWithOAuth, verifyEmail,
} from "../auth/service";
import type { Deps } from "../context";
import { AppError } from "../errors";
import { permissionsFor } from "../permissions";
import { listMyWorkspaces } from "../workspaces/service";
import { audit } from "../audit";
import { clearSessionCookie, idParam, metaOf, parse, requireUser, setSessionCookie } from "./util";

const Email = z.string().trim().min(3).max(254).email();
const Password = z.string().min(1).max(200);
const Name = z.string().trim().min(1).max(120);

export async function registerAuthRoutes(app: FastifyInstance, deps: Deps) {
  const strict = { config: { rateLimit: { max: deps.config.RATE_LIMIT_AUTH_PER_MIN, timeWindow: "1 minute" } } };
  const { config } = deps;

  app.get("/auth/config", async () => ({
    registration: config.ALLOW_REGISTRATION, requireEmailVerification: config.REQUIRE_EMAIL_VERIFICATION,
    oauth: { google: !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) },
    ai: deps.ai ? { provider: deps.ai.name } : null, billing: !!deps.billing,
    plans: deps.plans.all().map((p) => ({ id: p.id, name: p.name, priceMonthlyUsd: p.priceMonthlyUsd, limits: p.limits, features: p.features })),
  }));

  app.post("/auth/register", strict, async (req, reply) => {
    const body = parse(z.object({ email: Email, password: Password, name: Name }).strict(), req.body);
    const r = await register(deps, body, metaOf(req));
    setSessionCookie(deps, reply, r.session.token, r.session.expiresAt);
    return reply.status(201).send({ user: r.user, workspaceId: r.workspaceId });
  });

  app.post("/auth/login", strict, async (req, reply) => {
    const body = parse(z.object({ email: Email, password: Password }).strict(), req.body);
    const r = await login(deps, body.email, body.password, metaOf(req));
    setSessionCookie(deps, reply, r.session.token, r.session.expiresAt);
    return { user: r.user, workspaces: await listMyWorkspaces(deps, r.user.id) };
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.auth) await revokeSession(deps, req.auth.sessionId, req.auth.user.id);
    clearSessionCookie(deps, reply);
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const { user } = requireUser(req);
    const workspaces = await listMyWorkspaces(deps, user.id);
    return { user, workspaces: workspaces.map((w) => ({ ...w, permissions: permissionsFor(w.role) })) };
  });

  app.patch("/auth/profile", async (req) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ name: Name }).strict(), req.body);
    await deps.db.query("update users set name = $2 where id = $1", [user.id, body.name]);
    return { user: await getUser(deps, user.id) };
  });

  app.post("/auth/verify-email", strict, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200) }).strict(), req.body);
    await verifyEmail(deps, body.token, metaOf(req));
    return { ok: true };
  });

  app.post("/auth/resend-verification", strict, async (req) => {
    const { user } = requireUser(req);
    if (!user.emailVerified) await sendVerification(deps, user.id, user.email, user.name);
    return { ok: true };
  });

  app.post("/auth/forgot-password", strict, async (req) => {
    const body = parse(z.object({ email: Email }).strict(), req.body);
    await requestPasswordReset(deps, body.email, metaOf(req));
    return { ok: true }; // identical whether or not the account exists
  });

  app.post("/auth/reset-password", strict, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: Password }).strict(), req.body);
    await resetPassword(deps, body.token, body.password, metaOf(req));
    return { ok: true };
  });

  app.post("/auth/change-password", strict, async (req) => {
    const { user, sessionId } = requireUser(req);
    const body = parse(z.object({ currentPassword: Password, newPassword: Password }).strict(), req.body);
    await changePassword(deps, user.id, sessionId, body.currentPassword, body.newPassword, metaOf(req));
    return { ok: true };
  });

  app.get("/auth/sessions", async (req) => {
    const { user, sessionId } = requireUser(req);
    return { sessions: (await listSessions(deps, user.id)).map((s) => ({ ...s, current: s.id === sessionId })) };
  });
  app.delete("/auth/sessions/:id", async (req) => {
    const { user } = requireUser(req);
    const id = parse(idParam, (req.params as { id: string }).id);
    return { revoked: await revokeSession(deps, id, user.id) };
  });
  app.post("/auth/sessions/revoke-others", async (req) => {
    const { user, sessionId } = requireUser(req);
    await revokeAllSessions(deps.db, user.id, sessionId);
    await audit(deps.db, { actorId: user.id, action: "auth.sessions_revoked", ip: req.ip, requestId: req.id });
    return { ok: true };
  });

  /* ------------------------------ Google OAuth (code flow + PKCE) ------------------------------ */
  const oauthEnabled = !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
  const redirectUri = `${config.PUBLIC_API_URL}/api/v1/auth/oauth/google/callback`;
  const stateCookie = "vn_oauth";

  app.get("/auth/oauth/google/start", strict, async (req, reply) => {
    if (!oauthEnabled) throw new AppError(404, "not_found", "Google sign-in isn't enabled.");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    void reply.setCookie(stateCookie, `${state}.${verifier}`, { httpOnly: true, sameSite: "lax", secure: config.COOKIE_SECURE, path: "/api/v1/auth/oauth", signed: true, maxAge: 600 });
    const url = new URL(config.GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile",
      state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get("/auth/oauth/google/callback", strict, async (req, reply) => {
    if (!oauthEnabled) throw new AppError(404, "not_found", "Google sign-in isn't enabled.");
    const fail = (why: string) => reply.redirect(`${config.PUBLIC_WEB_URL}/login?error=${encodeURIComponent(why)}`);
    const q = req.query as { code?: string; state?: string; error?: string };
    const raw = req.cookies[stateCookie];
    void reply.clearCookie(stateCookie, { path: "/api/v1/auth/oauth" });
    if (q.error) return fail("Google sign-in was cancelled.");
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value || !q.code || !q.state) return fail("Sign-in expired. Please try again.");
    const [state, verifier] = unsigned.value.split(".");
    if (!state || !verifier || state !== q.state) return fail("Sign-in couldn't be verified. Please try again.");
    try {
      const tokenRes = await deps.fetch(config.GOOGLE_TOKEN_URL, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ code: q.code, client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }).toString(),
      });
      if (!tokenRes.ok) return fail("Google sign-in failed. Please try again.");
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) return fail("Google sign-in failed. Please try again.");
      const infoRes = await deps.fetch(config.GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
      if (!infoRes.ok) return fail("Google sign-in failed. Please try again.");
      const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
      if (!info.sub || !info.email) return fail("Google didn't share an email address.");
      const r = await signInWithOAuth(deps, { provider: "google", subject: info.sub, email: info.email, emailVerified: info.email_verified === true, name: info.name ?? "" }, metaOf(req));
      setSessionCookie(deps, reply, r.session.token, r.session.expiresAt);
      return reply.redirect(`${config.PUBLIC_WEB_URL}/app`);
    } catch (e) {
      if (e instanceof AppError) return fail(e.message);
      req.log.error({ err: e }, "google oauth failed");
      return fail("Google sign-in failed. Please try again.");
    }
  });

}
