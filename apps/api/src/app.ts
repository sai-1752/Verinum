import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { AnalyticsError } from "@verinum/core";
import { ZodError } from "zod";
import { resolveSession } from "./auth/service";
import type { Deps } from "./context";
import { AppError, forbidden } from "./errors";
import { registerAdminRoutes } from "./routes/admin";
import { registerAnalysisRoutes } from "./routes/analysis";
import { registerAuthRoutes } from "./routes/auth";
import { registerChatRoutes } from "./routes/chat";
import { registerDatasetRoutes } from "./routes/datasets";
import { registerSystemRoutes } from "./routes/system";
import { registerWorkspaceRoutes } from "./routes/workspaces";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const maxUpload = Math.max(...deps.plans.all().map((p) => (p.limits.maxUploadBytes < 0 ? 512 * 1024 * 1024 : p.limits.maxUploadBytes)));

  const app = Fastify({
    loggerInstance: deps.log as unknown as FastifyBaseLogger,
    trustProxy: config.TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    routerOptions: { maxParamLength: 200 },
    requestIdHeader: false,
  });

  app.decorateRequest("auth", null);

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: "same-site" } });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin.replace(/\/$/, ""))),
    credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], maxAge: 600,
  });
  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(rateLimit, { global: true, max: config.RATE_LIMIT_GLOBAL_PER_MIN, timeWindow: "1 minute", allowList: [], errorResponseBuilder: () => new AppError(429, "rate_limited", "Too many requests. Please slow down.") });
  await app.register(multipart, { limits: { fileSize: maxUpload, files: 1, fields: 10, parts: 12 }, throwFileSizeLimit: true });

  // Raw body for signature-verified webhooks; everything else is parsed as normal JSON
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!(body as string).length) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(new AppError(400, "bad_json", "The request body isn't valid JSON."), undefined); }
  });

  /* ---- per-request: request id header, session, CSRF ---- */
  app.addHook("onRequest", async (req, reply) => {
    void reply.header("x-request-id", req.id);
    void reply.header("cache-control", "no-store");
    const token = req.cookies[config.SESSION_COOKIE_NAME];
    req.auth = null;
    if (token) {
      const s = await resolveSession(deps, token).catch((e) => { req.log.error({ err: e }, "session lookup failed"); return null; });
      if (s) req.auth = s;
    }
    // CSRF: a browser request that carries our cookie and changes state must come from our own origin.
    // (SameSite=Lax already blocks cross-site POSTs; this closes the remaining gaps such as same-site subdomains.)
    if (token && UNSAFE.has(req.method)) {
      const origin = (req.headers.origin as string | undefined)?.replace(/\/$/, "");
      if (!origin || !config.allowedOrigins.includes(origin)) {
        throw forbidden("This request was blocked because it didn't come from the Verinum app.");
      }
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    deps.metrics.inc("http_requests_total", { method: req.method, route, status: reply.statusCode }, 1, "HTTP requests");
    deps.metrics.observe("http_request_duration_seconds", reply.elapsedTime / 1000, { method: req.method, route }, "HTTP request latency");
  });

  app.setErrorHandler((err: Error & { code?: string; statusCode?: number; validation?: unknown }, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), requestId } });
    }
    if (err instanceof AnalyticsError) return reply.status(422).send({ error: { code: err.code, message: err.message, ...(err.hint ? { details: { hint: err.hint } } : {}), requestId } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "bad_request", message: err.issues[0]?.message ?? "Invalid request.", requestId } });
    if (err.code === "FST_REQ_FILE_TOO_LARGE" || err.code === "FST_FILES_LIMIT" || err.statusCode === 413) {
      return reply.status(413).send({ error: { code: "too_large", message: "That file is too large.", requestId } });
    }
    if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") return reply.status(400).send({ error: { code: "bad_request", message: "Unsupported or empty request body.", requestId } });
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: "bad_request", message: "The request could not be processed.", requestId } });
    // Postgres: row-level-security or permission violations are an isolation bug if they ever surface here
    if (err.code === "42501") { req.log.error({ err }, "database refused an operation (RLS / privilege)"); return reply.status(403).send({ error: { code: "forbidden", message: "You don't have permission to do that.", requestId } }); }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong on our side. Please try again.", requestId } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "not_found", message: "That route doesn't exist.", requestId: req.id } }));

  await registerSystemRoutes(app, deps);
  await app.register(async (api) => {
    await registerAuthRoutes(api, deps);
    await registerWorkspaceRoutes(api, deps);
    await registerDatasetRoutes(api, deps);
    await registerAnalysisRoutes(api, deps);
    await registerChatRoutes(api, deps);
    await registerAdminRoutes(api, deps);
  }, { prefix: "/api/v1" });

  return app as unknown as FastifyInstance;
}
