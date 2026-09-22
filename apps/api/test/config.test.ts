import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

const KEY = randomBytes(32).toString("base64");
const prod = (over: Record<string, string> = {}) => ({
  NODE_ENV: "production", PUBLIC_WEB_URL: "https://app.example.com", COOKIE_SECURE: "true", COOKIE_SECRET: "x".repeat(48),
  DATABASE_URL: "postgres://verinum_app:s3cret@db/verinum", STORAGE_ENCRYPTION_KEY: KEY, MAIL_DRIVER: "smtp", SMTP_URL: "smtp://mail.example.com", ...over,
});
const problems = (env: Record<string, string>): string => { try { loadConfig(env); return ""; } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as Error).message; } };

describe("production configuration is refused unless it is safe", () => {
  it("accepts a complete production configuration", () => {
    expect(problems(prod())).toBe("");
  });
  it.each([
    ["insecure cookies", { COOKIE_SECURE: "false" }, /COOKIE_SECURE/],
    ["no storage encryption key", { STORAGE_ENCRYPTION_KEY: "" }, /STORAGE_ENCRYPTION_KEY/],
    ["the development database password", { DATABASE_URL: "postgres://verinum_app:app_dev_pw@db/verinum" }, /development password/],
    ["a non-https public URL", { PUBLIC_WEB_URL: "http://app.example.com" }, /https/],
    ["the development cookie secret", { COOKIE_SECRET: "dev-only-cookie-secret-change-me-please-0123456789" }, /COOKIE_SECRET/],
    ["mail kept in memory", { MAIL_DRIVER: "memory" }, /MAIL_DRIVER=memory/],
    ["mail written to files (links carry tokens)", { MAIL_DRIVER: "file" }, /MAIL_DRIVER=file/],
    ["a key of the wrong length", { STORAGE_ENCRYPTION_KEY: Buffer.from("too short").toString("base64") }, /32 bytes/],
    ["the AI provider without a key", { AI_PROVIDER: "anthropic" }, /ANTHROPIC_API_KEY/],
    ["billing without a webhook secret", { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_x" }, /STRIPE_WEBHOOK_SECRET/],
  ])("refuses %s", (_name, over, re) => {
    expect(problems(prod(over))).toMatch(re);
  });
  it("reports every problem at once, not just the first", () => {
    const msg = problems(prod({ COOKIE_SECURE: "false", MAIL_DRIVER: "file", PUBLIC_WEB_URL: "http://x.test" }));
    expect(msg).toMatch(/COOKIE_SECURE/); expect(msg).toMatch(/MAIL_DRIVER=file/); expect(msg).toMatch(/https/);
  });
  it("development is permissive so a clone runs with no set-up beyond a database", () => {
    expect(problems({ NODE_ENV: "development", MAIL_DRIVER: "file" })).toBe("");
  });
  it("rejects malformed values with the variable named", () => {
    expect(problems({ PORT: "not-a-number" })).toMatch(/PORT/);
  });
});
