/** Config-driven plans: limits and feature flags live in config/plans.json (or PLANS_FILE). -1 = unlimited. */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { planLimit } from "./errors";
import { appFile } from "./paths";

const Limits = z.object({
  maxDatasets: z.number().int(), maxUploadBytes: z.number().int(), maxRowsPerDataset: z.number().int(), maxMembers: z.number().int(),
  aiMessagesPerMonth: z.number().int(), exportsPerMonth: z.number().int(), storageBytes: z.number().int(),
});
const Features = z.object({ forecast: z.boolean(), cohort: z.boolean(), export: z.boolean(), aiChat: z.boolean(), rowExamples: z.boolean() });
const PlanSchema = z.object({ name: z.string(), priceMonthlyUsd: z.number(), stripePriceEnv: z.string().optional(), limits: Limits, features: Features });
const Plans = z.record(PlanSchema).refine((p) => "free" in p, "a 'free' plan is required");

export type PlanLimits = z.infer<typeof Limits>;
export type PlanFeatures = z.infer<typeof Features>;
export interface Plan extends z.infer<typeof PlanSchema> { id: string }

export class PlanCatalog {
  private readonly plans: Map<string, Plan>;
  constructor(raw: unknown) {
    const parsed = Plans.parse(raw);
    this.plans = new Map(Object.entries(parsed).map(([id, p]) => [id, { id, ...p }]));
  }
  static load(file?: string): PlanCatalog {
    const path = file ?? appFile("config", "plans.json");
    return new PlanCatalog(JSON.parse(readFileSync(path, "utf8")));
  }
  get(id: string): Plan { return this.plans.get(id) ?? this.plans.get("free")!; }
  has(id: string): boolean { return this.plans.has(id); }
  all(): Plan[] { return [...this.plans.values()]; }
  defaultId = "free";
}

export const isUnlimited = (n: number) => n < 0;
export const fmtBytes = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`);

/** Throws a 402 `plan_limit` error when `used + adding` would exceed the limit. */
export function enforce(plan: Plan, limit: keyof PlanLimits, used: number, adding: number, what: string): void {
  const max = plan.limits[limit];
  if (isUnlimited(max)) return;
  if (used + adding > max) {
    throw planLimit(limit, `Your ${plan.name} plan allows ${limit.includes("Bytes") ? fmtBytes(max) : max.toLocaleString("en-US")} ${what}. Upgrade to add more.`, { max, used, plan: plan.id });
  }
}
