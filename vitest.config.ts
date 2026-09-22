import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
    globalSetup: ["./scripts/vitest-global-setup.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // API integration tests share one Postgres database; run files serially there.
    fileParallelism: false,
  },
});
