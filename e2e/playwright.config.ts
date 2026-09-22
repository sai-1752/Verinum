import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export const API_PORT = 4600;
export const MOCK_PORT = 4610;
export const WEB_PORT = 4173;
export const WEB = `http://127.0.0.1:${WEB_PORT}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.E2E_DB_OWNER_URL ?? "postgres://verinum_owner:owner_dev_pw@127.0.0.1:5432/verinum_e2e";
const APP_DB = process.env.E2E_DB_APP_URL ?? "postgres://verinum_app:app_dev_pw@127.0.0.1:5432/verinum_e2e";
// The sandbox ships a pre-installed Chromium; elsewhere Playwright's own browser is used.
const sandboxChromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./specs",
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "./.results",
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--no-sandbox"], ...(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {}) },
  },
  projects: [
    { name: "desktop", testIgnore: /mobile\.spec/, use: { viewport: { width: 1280, height: 860 } } },
    { name: "mobile", testMatch: /mobile\.spec/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: [
    {
      command: "npx tsx e2e/mock-anthropic.ts",
      cwd: root,
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      reuseExistingServer: false,
      env: { MOCK_ANTHROPIC_PORT: String(MOCK_PORT) },
    },
    {
      command: "node e2e/scripts/prepare-db.mjs && node apps/api/dist/server.mjs",
      cwd: root,
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(API_PORT), LOG_LEVEL: "warn",
        PUBLIC_WEB_URL: WEB, PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
        DATABASE_URL: APP_DB, DATABASE_MIGRATION_URL: DB, E2E_DB_OWNER_URL: DB,
        MAIL_DRIVER: "file", MAIL_FILE_DIR: resolve(root, "e2e/.outbox"),
        STORAGE_LOCAL_DIR: resolve(root, "e2e/.storage"),
        AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-e2e-not-real", ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        METRICS_TOKEN: "e2e-metrics-token",
        RATE_LIMIT_GLOBAL_PER_MIN: "100000", RATE_LIMIT_AUTH_PER_MIN: "100000",
      },
    },
    {
      command: `npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: resolve(root, "apps/web"),
      url: WEB,
      reuseExistingServer: false,
      env: { VITE_API_PROXY: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
