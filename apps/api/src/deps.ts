import { createToolRegistry } from "@verinum/core";
import { createProvider } from "./ai";
import { createBilling } from "./billing/service";
import type { Config } from "./config";
import type { Deps } from "./context";
import { FrameCache } from "./datasets/frame-cache";
import { Db } from "./db";
import { createLogger } from "./logger";
import { FileMailer, LogMailer, MemoryMailer, SmtpMailer, type Mailer } from "./mail";
import { Metrics } from "./metrics";
import { PlanCatalog } from "./plans";
import { createStorage, EncryptedStore, LocalStore, S3Store, type ObjectStore } from "./storage";

export function buildDeps(config: Config, overrides: Partial<Deps> = {}): Deps {
  const log = overrides.log ?? createLogger(config);
  const fetchFn = overrides.fetch ?? fetch;
  const plans = overrides.plans ?? PlanCatalog.load(process.env.PLANS_FILE);
  let inner: ObjectStore = config.STORAGE_DRIVER === "s3"
    ? new S3Store({ bucket: config.S3_BUCKET!, region: config.S3_REGION, endpoint: config.S3_ENDPOINT || undefined, forcePathStyle: config.S3_FORCE_PATH_STYLE })
    : new LocalStore(config.STORAGE_LOCAL_DIR);
  if (config.STORAGE_ENCRYPTION_KEY) inner = new EncryptedStore(inner, Buffer.from(config.STORAGE_ENCRYPTION_KEY, "base64"));
  const mailer: Mailer = config.MAIL_DRIVER === "smtp" ? new SmtpMailer(config.SMTP_URL!, config.MAIL_FROM) : config.MAIL_DRIVER === "memory" ? new MemoryMailer() : config.MAIL_DRIVER === "file" ? new FileMailer(config.MAIL_FILE_DIR) : new LogMailer(log);
  const deps: Deps = {
    config, log,
    db: new Db(config.DATABASE_URL, config.DATABASE_POOL_MAX),
    storage: createStorage(inner),
    mailer, plans,
    metrics: new Metrics(),
    frames: new FrameCache(config.FRAME_CACHE_MB * 1024 * 1024),
    registry: createToolRegistry(undefined, (err, info) => log.error({ err, tool: info.tool }, "analysis tool crashed")),
    ai: createProvider(config, fetchFn),
    billing: createBilling(config, plans, fetchFn),
    fetch: fetchFn,
    now: () => new Date(),
    ...overrides,
  };
  deps.metrics.gauge("frame_cache_bytes", () => deps.frames.bytes, "Bytes held by the dataset cache");
  deps.metrics.gauge("frame_cache_entries", () => deps.frames.size, "Datasets held in memory");
  return deps;
}
