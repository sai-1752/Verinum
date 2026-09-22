import type { FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodTypeAny } from "zod";
import type { Deps } from "../context";
import { badRequest, forbidden, unauthorized } from "../errors";
import type { Action } from "../permissions";
import type { ReqMeta } from "../auth/service";
import { resolveWorkspace, type WorkspaceCtx } from "../workspaces/service";

/** Validates untrusted input; the error message names the first offending field. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
  const first = issues[0];
  throw badRequest(first ? `${first.field ? `${first.field}: ` : ""}${first.message}` : "Invalid request.", { issues });
}

export function requireUser(req: FastifyRequest) {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export const metaOf = (req: FastifyRequest): ReqMeta => ({ ip: req.ip, userAgent: (req.headers["user-agent"] as string | undefined) ?? null, requestId: req.id });

/** Resolves `:workspaceId` through a verified membership and checks the role's permission. */
export async function workspaceFor(deps: Deps, req: FastifyRequest, action: Action): Promise<WorkspaceCtx> {
  const { user } = requireUser(req);
  const { workspaceId } = req.params as { workspaceId?: string };
  const ctx = await resolveWorkspace(deps, user.id, workspaceId ?? "", action);
  if (deps.config.REQUIRE_EMAIL_VERIFICATION && !user.emailVerified) throw forbidden("Verify your email address to continue.");
  return ctx;
}

export function setSessionCookie(deps: Deps, reply: FastifyReply, token: string, expiresAt: Date) {
  void reply.setCookie(deps.config.SESSION_COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", secure: deps.config.COOKIE_SECURE, path: "/", expires: expiresAt });
}
export function clearSessionCookie(deps: Deps, reply: FastifyReply) {
  void reply.clearCookie(deps.config.SESSION_COOKIE_NAME, { path: "/", httpOnly: true, sameSite: "lax", secure: deps.config.COOKIE_SECURE });
}

export const idParam = z.string().uuid();
