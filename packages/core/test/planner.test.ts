import { describe, expect, it } from "vitest";
import { buildProfile } from "../src/profile";
import { createContext } from "../src/context";
import { createToolRegistry } from "../src/tools";
import { planQuestion, starterQuestions, suggestFollowUps } from "../src/planner";
import { demoClean } from "./helpers/fixtures";

const clean = demoClean();
const profile = buildProfile(clean.frame, clean);
const ctx = createContext(clean.frame, profile);
const reg = createToolRegistry();

const cases: [string, string, Record<string, unknown>?][] = [
  ["What are the top 5 products?", "top_n", { dimension: "Product", n: 5 }],
  ["top 3 customers by sales", "top_n", { dimension: "Customer", n: 3, metric: "Sales" }],
  ["Which region has the lowest revenue?", "top_n", { dimension: "Region", order: "asc", n: 1 }],
  ["worst 5 products by profit", "top_n", { dimension: "Product", order: "asc", n: 5, metric: "Profit" }],
  ["What is total sales?", "aggregate", { metric: "Sales" }],
  ["average profit", "aggregate", { metric: "Profit", agg: "avg" }],
  ["how many customers do we have", "aggregate", { metric: "Customer", agg: "distinct_count" }],
  ["Show revenue by region", "group_by", { dimension: "Region", metric: "Sales" }],
  ["How has sales changed over time?", "time_series", { metric: "Sales" }],
  ["monthly sales", "time_series", { metric: "Sales", grain: "month" }],
  ["what is the sales trend", "trend", { metric: "Sales" }],
  ["Why did sales drop last month?", "explain_change", { metric: "Sales" }],
  ["What's the forecast for sales?", "forecast", { metric: "Sales" }],
  ["predict next month", "forecast"],
  ["Compare North America and EMEA", "compare_groups", { dimension: "Region", group_a: "North America", group_b: "EMEA" }],
  ["compare 2026-03 with 2026-02 sales", "compare_periods", { period_a: "2026-03", period_b: "2026-02" }],
  ["what share of sales comes from EMEA", "share_of_total", { dimension: "Region", value: "EMEA" }],
  ["any unusual months?", "anomalies"],
  ["which products have the lowest margin", "top_n"],
  ["which segments are least profitable", "profitability"],
  ["is discount correlated with profit", "correlation", { column_a: "Discount", column_b: "Profit" }],
  ["how concentrated is revenue across products", "pareto", { dimension: "Product" }],
  ["customer retention by cohort", "cohort_retention"],
  ["how good is the data quality", "data_quality"],
  ["what columns does this dataset have", "describe_dataset"],
  ["sales in EMEA in 2026", "aggregate", { metric: "Sales", date_from: "2026", date_to: "2026", filters: [{ column: "Region", op: "eq", value: "EMEA" }] }],
  ["margin over time", "time_series", { metric: "margin" }],
  ["is there seasonality", "seasonality"],
];

describe("deterministic planner", () => {
  for (const [q, tool, params] of cases) {
    it(`"${q}" → ${tool}`, () => {
      const plan = planQuestion(ctx, q);
      expect(plan, q).not.toBeNull();
      // the lowest-margin question is a ranking; accept either ranking or profitability
      if (q.startsWith("which products have the lowest margin")) { expect(["top_n", "profitability"]).toContain(plan!.tool); return; }
      expect(plan!.tool).toBe(tool);
      if (params) expect(plan!.params).toMatchObject(params);
      const r = reg.call(ctx, plan!.tool, plan!.params);
      if (tool === "seasonality") { expect(r.ok).toBe(false); expect((r as { message: string }).message).toMatch(/two full cycles/); return; }
      expect(r.ok, `${plan!.tool} ${JSON.stringify(plan!.params)} → ${r.ok ? "" : (r as { message: string }).message}`).toBe(true);
    });
  }
  it("returns null when nothing in the question maps to the data", () => {
    expect(planQuestion(ctx, "tell me a joke")).toBeNull();
    expect(planQuestion(ctx, "")).toBeNull();
  });
  it("every starter question is answerable, and follow-ups are too", () => {
    const starters = starterQuestions(ctx);
    expect(starters.length).toBeGreaterThanOrEqual(4);
    for (const s of [...starters, ...suggestFollowUps(ctx, "top_n"), ...suggestFollowUps(ctx, "time_series"), ...suggestFollowUps(ctx, "forecast")]) {
      const plan = planQuestion(ctx, s);
      expect(plan, s).not.toBeNull();
      const r = reg.call(ctx, plan!.tool, plan!.params);
      expect(r.ok, `${s} → ${plan!.tool}`).toBe(true);
    }
  });
});
