/** Application errors: a stable machine code, a user-safe message, and never any internals. */
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new AppError(400, "bad_request", message, details);
export const unauthorized = (message = "Sign in to continue.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, "forbidden", message);
export const notFound = (what = "That") => new AppError(404, "not_found", `${what} was not found.`);
export const conflict = (message: string, code = "conflict") => new AppError(409, code, message);
export const tooManyRequests = (message = "Too many requests. Please slow down.") => new AppError(429, "rate_limited", message);
/** A plan limit was reached: 402 so clients can show an upgrade prompt. */
export const planLimit = (limit: string, message: string, details: Record<string, unknown> = {}) => new AppError(402, "plan_limit", message, { limit, ...details });
export const unprocessable = (message: string, code = "unprocessable", details?: Record<string, unknown>) => new AppError(422, code, message, details);
