import { z } from "zod";

const bool = (d: boolean) => z.enum(["true", "false", "1", "0"]).optional().transform((v) => (v === undefined ? d : v === "true" || v === "1"));
const int = (d: number) => z.string().optional().transform((v, ctx) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n)) { ctx.addIssue({ code: "custom", message: "must be an integer" }); return z.NEVER; }
  return n;
});

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: int(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:5173"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  /** extra allowed browser origins, comma-separated */
  CORS_ORIGINS: z.string().default(""),

  DATABASE_URL: z.string().default("postgres://verinum_app:app_dev_pw@127.0.0.1:5432/verinum"),
  // The schema-owner URL (DATABASE_MIGRATION_URL) is deliberately NOT part of the server configuration: only the
  // migrate/admin commands read it, so the running API never needs, and in production never receives, owner credentials.
  DATABASE_POOL_MAX: int(20),

  SESSION_COOKIE_NAME: z.string().default("vn_session"),
  /** signs short-lived cookies (OAuth state). Required in production. */
  COOKIE_SECRET: z.string().default("dev-only-cookie-secret-change-me-please-0123456789"),
  TRUST_PROXY: bool(false),
  SESSION_TTL_DAYS: int(30),
  COOKIE_SECURE: bool(false),
  ALLOW_REGISTRATION: bool(true),
  REQUIRE_EMAIL_VERIFICATION: bool(false),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage-data"),
  /** base64, 32 bytes. Encrypts every stored object (AES-256-GCM). Required in production. */
  STORAGE_ENCRYPTION_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(false),

  MAIL_DRIVER: z.enum(["smtp", "log", "memory", "file"]).default("log"),
  /** where MAIL_DRIVER=file writes messages (never allowed in production) */
  MAIL_FILE_DIR: z.string().default("./mail-outbox"),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Verinum <no-reply@verinum.local>"),

  AI_PROVIDER: z.enum(["anthropic", "openai", "none"]).default("none"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1"),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com"),
  AI_TIMEOUT_MS: int(60_000),
  AI_MAX_OUTPUT_TOKENS: int(1500),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_AUTH_URL: z.string().default("https://accounts.google.com/o/oauth2/v2/auth"),
  GOOGLE_TOKEN_URL: z.string().default("https://oauth2.googleapis.com/token"),
  GOOGLE_USERINFO_URL: z.string().default("https://openidconnect.googleapis.com/v1/userinfo"),

  BILLING_PROVIDER: z.enum(["stripe", "none"]).default("none"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_BASE: z.string().default("https://api.stripe.com"),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_TEAM: z.string().optional(),

  WORKER_ENABLED: bool(true),
  WORKER_CONCURRENCY: int(2),
  WORKER_POLL_MS: int(1000),
  JOB_LEASE_SECONDS: int(120),
  INGEST_MEMORY_MB: int(2048),

  RATE_LIMIT_GLOBAL_PER_MIN: int(600),
  RATE_LIMIT_AUTH_PER_MIN: int(10),
  METRICS_TOKEN: z.string().optional(),
  DEMO_DATASET_PATH: z.string().optional(),
  FRAME_CACHE_MB: int(512),
});

export type Config = z.infer<typeof Env> & { isProd: boolean; isTest: boolean; allowedOrigins: string[] };

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const c = parsed.data;
  const problems: string[] = [];
  const isProd = c.NODE_ENV === "production";
  if (isProd) {
    if (!c.COOKIE_SECURE) problems.push("COOKIE_SECURE must be true in production");
    if (!c.STORAGE_ENCRYPTION_KEY) problems.push("STORAGE_ENCRYPTION_KEY is required in production");
    if (c.DATABASE_URL.includes("app_dev_pw")) problems.push("DATABASE_URL still uses the development password");
    if (!c.PUBLIC_WEB_URL.startsWith("https://")) problems.push("PUBLIC_WEB_URL must be https in production");
    if (c.COOKIE_SECRET.startsWith("dev-only")) problems.push("COOKIE_SECRET must be set in production");
    if (c.MAIL_DRIVER === "memory" || c.MAIL_DRIVER === "file") problems.push(`MAIL_DRIVER=${c.MAIL_DRIVER} is not allowed in production`);
  }
  if (c.STORAGE_ENCRYPTION_KEY && Buffer.from(c.STORAGE_ENCRYPTION_KEY, "base64").length !== 32) problems.push("STORAGE_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  if (c.STORAGE_DRIVER === "s3" && !c.S3_BUCKET) problems.push("S3_BUCKET is required when STORAGE_DRIVER=s3");
  if (c.MAIL_DRIVER === "smtp" && !c.SMTP_URL) problems.push("SMTP_URL is required when MAIL_DRIVER=smtp");
  if (c.AI_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
  if (c.AI_PROVIDER === "openai" && !c.OPENAI_API_KEY) problems.push("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  if (c.BILLING_PROVIDER === "stripe" && (!c.STRIPE_SECRET_KEY || !c.STRIPE_WEBHOOK_SECRET)) problems.push("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when BILLING_PROVIDER=stripe");
  if (problems.length) throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  const allowedOrigins = [c.PUBLIC_WEB_URL, ...c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)].map((o) => o.replace(/\/$/, ""));
  return { ...c, isProd, isTest: c.NODE_ENV === "test", allowedOrigins };
}
