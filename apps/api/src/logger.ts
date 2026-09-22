import pino, { type Logger } from "pino";
import type { Config } from "./config";

export function createLogger(cfg: Pick<Config, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return pino({
    level: cfg.NODE_ENV === "test" ? "silent" : cfg.LOG_LEVEL,
    base: { service: "verinum-api" },
    // secrets never reach logs
    redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "*.password", "*.newPassword", "*.currentPassword", "*.token", "*.code", "*.apiKey"], censor: "[redacted]" },
    ...(cfg.NODE_ENV === "development" ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
  });
}
