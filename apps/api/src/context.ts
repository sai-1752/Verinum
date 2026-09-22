import "fastify";
import type { Logger } from "pino";
import type { LlmProvider, ToolRegistry } from "@verinum/core";
import type { Config } from "./config";
import type { Db } from "./db";
import type { Mailer } from "./mail";
import type { Metrics } from "./metrics";
import type { PlanCatalog } from "./plans";
import type { StorageService } from "./storage";
import type { FrameCache } from "./datasets/frame-cache";
import type { BillingProvider } from "./billing/provider";

export interface Deps {
  config: Config;
  log: Logger;
  db: Db;
  storage: StorageService;
  mailer: Mailer;
  plans: PlanCatalog;
  metrics: Metrics;
  frames: FrameCache;
  registry: ToolRegistry;
  /** null when no AI provider is configured: chat then answers deterministically */
  ai: LlmProvider | null;
  billing: BillingProvider | null;
  fetch: typeof fetch;
  now: () => Date;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: { user: AuthUser; sessionId: string } | null;
  }
}
