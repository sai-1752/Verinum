import type { FastifyInstance } from "fastify";
import { applyBillingEvent } from "../billing/service";
import type { Deps } from "../context";
import { AppError, forbidden } from "../errors";
import { safeEqual } from "../security/crypto";

export async function registerSystemRoutes(app: FastifyInstance, deps: Deps) {
  // liveness: the process is up. readiness: it can reach its database.
  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get("/readyz", { config: { rateLimit: false } }, async (_req, reply) => {
    const db = await deps.db.ping();
    return reply.status(db ? 200 : 503).send({ ok: db, checks: { database: db } });
  });

  app.get("/metrics", { config: { rateLimit: false } }, async (req, reply) => {
    const token = deps.config.METRICS_TOKEN;
    if (deps.config.isProd && !token) throw forbidden("Metrics are disabled.");
    if (token) {
      const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!given || !safeEqual(given, token)) throw forbidden("Metrics require a bearer token.");
    }
    return reply.header("content-type", "text/plain; version=0.0.4").send(deps.metrics.render());
  });

  // Billing provider webhook: authenticated by signature over the raw body, never by cookie.
  app.post("/api/v1/billing/webhook", async (req, reply) => {
    if (!deps.billing) throw new AppError(404, "not_found", "Billing isn't enabled.");
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    const event = deps.billing.parseWebhook(raw, req.headers["stripe-signature"] as string | undefined, Math.floor(deps.now().getTime() / 1000));
    const r = await applyBillingEvent(deps, event);
    return reply.send({ received: true, ...r });
  });
}
