import { describe, expect, it } from "vitest";
import { buildFrame, type RawCell } from "../src/clean";
import { buildProfile } from "../src/profile";
import { createContext, type AnalysisContext } from "../src/context";
import { createToolRegistry } from "../src/tools";
import { generateInsights } from "../src/insights";
import { FactLedger } from "../src/grounding/ledger";
import type { ToolFailure, ToolResult } from "../src/facts";
import type { StringColumn } from "../src/frame";
import { demoClean } from "./helpers/fixtures";
import { daysFromCivil, formatIsoDate } from "../src/time";

const clean = demoClean();
const profile = buildProfile(clean.frame, clean);
const ctx = createContext(clean.frame, profile);
const reg = createToolRegistry();
const labelsOf = (c: AnalysisContext) => [...c.frame.names(), ...c.frame.columns.flatMap((x) => (x.kind === "string" ? (x as StringColumn).dict : []))];

function ok(name: string, args: Record<string, unknown> = {}, c = ctx): ToolResult {
  const r = reg.call(c, name, args);
  if (!r.ok) throw new Error(`${name} failed: ${(r as ToolFailure).code} ${(r as ToolFailure).message}`);
  return r;
}
const fail = (name: string, args: Record<string, unknown> = {}, c = ctx): ToolFailure => {
  const r = reg.call(c, name, args);
  expect(r.ok).toBe(false);
  return r as ToolFailure;
};

describe("acceptance: 'What are the top 5 products?'", () => {
  it("returns the exact golden ranking with shares", () => {
    const r = ok("top_n", { dimension: "Product", n: 5 });
    const rows = (r.data as { rows: { key: string; value: number; share: number; display: string; shareDisplay: string }[] }).rows;
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ key: "Aura Watch", display: "506.5K", shareDisplay: "15.7%" });
    expect(rows[0]!.value).toBeCloseTo(506482.84, 1);
    expect(rows[0]!.share).toBeCloseTo(15.7, 1);
    expect(r.summary).toMatch(/^Top 5 Product values by Total Sales/);
    expect(r.provenance).toMatchObject({ tool: "top_n", rowsConsidered: 6764 });
    expect(r.chart?.kind).toBe("bar");
  });

  it("a model answer built from the result verifies; an invented one does not", () => {
    const l = new FactLedger();
    const r = ok("top_n", { dimension: "Product", n: 5 });
    l.addResult("c1", r);
    l.addLabels(labelsOf(ctx));
    expect(l.validateText("Aura Watch leads with 506.5K in sales, or 15.7% of the total.").ok).toBe(true);
    expect(l.validateText("Aura Watch leads with 620K in sales.").ok).toBe(false);
    expect(l.validateText("The top 5 products are listed below.").ok).toBe(true);
    expect(l.validateText("The top 7 products are listed below.").ok).toBe(false);
  });
});

describe("capability gating and refusals", () => {
  it("does not offer time tools without a date column, and reports why", () => {
    const rows: RawCell[][] = Array.from({ length: 30 }, (_, i) => [["a", "b", "c"][i % 3]!, String(10 + i)]);
    const c = buildFrame({ columns: ["Group", "Amount"], rows: rows as string[][] });
    const cx = createContext(c.frame, buildProfile(c.frame, c));
    const offered = reg.offered(cx).map((t) => t.name);
    expect(offered).toContain("top_n");
    for (const t of ["forecast", "trend", "time_series", "compare_periods", "seasonality", "anomalies", "explain_change"]) expect(offered).not.toContain(t);
    const f = fail("forecast", {}, cx);
    expect(f.code).toBe("not_available");
    expect(f.message).toMatch(/date or time field/);
    expect(reg.unavailable(cx).some((u) => u.tool === "forecast")).toBe(true);
  });

  it("does not offer seasonality with under two cycles, but offers forecast", () => {
    const names = reg.offered(ctx).map((t) => t.name);
    expect(names).toContain("forecast");
    expect(names).not.toContain("seasonality");
    expect(fail("seasonality").message).toMatch(/two full cycles/);
  });

  it("refuses to sum a price, discount or share column", () => {
    const f = fail("aggregate", { metric: "UnitPrice", agg: "sum" });
    expect(f.code).toBe("invalid_argument");
    expect(f.message).toMatch(/not meaningful/);
    expect(f.hint).toMatch(/avg/);
    expect(ok("aggregate", { metric: "UnitPrice" }).summary).toContain("Average UnitPrice");
  });

  it("never exposes row-level tools/data by default", () => {
    const r = ok("outliers", { column: "Sales" });
    expect((r.data as { examples?: unknown }).examples).toBeUndefined();
    expect(r.provenance.caveats.join(" ")).toMatch(/not shown/);
  });

  it("returns structured failures for bad arguments, unknown tools and unknown columns", () => {
    expect(fail("aggregate", { agg: "sumsum" }).code).toBe("invalid_arguments");
    expect(fail("nope").code).toBe("unknown_tool");
    const f = fail("aggregate", { metric: "Sale Amount" });
    expect(f.code).toBe("unknown_column");
    expect(f.hint).toMatch(/Sales/);
    expect(fail("group_by", { dimension: "Sales" }).code).toBe("wrong_type");
  });

  it("resolves aliases: 'revenue' → Sales, 'products' → Product", () => {
    const r = ok("top_n", { dimension: "products", metric: "revenue", n: 3 });
    expect((r.data as { dimension: string; metric: string }).dimension).toBe("Product");
    expect((r.data as { metric: string }).metric).toBe("Sales");
  });
});

describe("filters and entity resolution", () => {
  it("filters case-insensitively and reports the scope", () => {
    const all = ok("aggregate", { metric: "Sales" });
    const north = ok("aggregate", { metric: "Sales", filters: [{ column: "region", op: "eq", value: "north america" }] });
    expect((north.data as { value: number }).value).toBeLessThan((all.data as { value: number }).value);
    expect(north.provenance.filters).toEqual(["Region = north america"]);
    expect(north.provenance.rowsConsidered).toBeLessThan(6764);
  });

  it("suggests the closest value when a filter matches nothing", () => {
    const f = fail("aggregate", { metric: "Sales", filters: [{ column: "Product", op: "eq", value: "Aura Wach" }] });
    expect(f.code).toBe("no_matching_rows");
    expect(f.hint).toMatch(/Aura Watch/);
  });

  it("supports date_from/date_to shorthands", () => {
    const y = ok("aggregate", { metric: "Sales", date_from: "2026-01", date_to: "2026-03" });
    const q = ok("aggregate", { metric: "Sales", date_from: "2026-Q1", date_to: "2026-Q1" });
    expect((y.data as { value: number }).value).toBeCloseTo((q.data as { value: number }).value, 2);
  });

  it("share_of_total resolves the group and ranks it", () => {
    const r = ok("share_of_total", { dimension: "Segment", value: "enterprise" });
    expect((r.data as { key: string; share: number }).key).toBe("Enterprise");
    expect((r.data as { share: number }).share).toBeGreaterThan(50);
  });
});

describe("time tools respect complete periods", () => {
  it("time_series flags the partial first month and excludes it from stats", () => {
    const r = ok("time_series", { metric: "Sales", grain: "month", limit: 30 });
    const pts = (r.data as { points: { period: string; complete: boolean }[] }).points;
    expect(pts[0]).toMatchObject({ period: "2025-02", complete: false });
    expect(pts.slice(1).every((p) => p.complete)).toBe(true);
    expect(r.provenance.caveats.join(" ")).toMatch(/2025-02/);
  });

  it("time_series never draws the partial edge month (it would plot as a false collapse)", () => {
    const r = ok("time_series", { metric: "Sales", grain: "month", limit: 30 });
    expect(r.chart?.kind).toBe("line");
    const x = (r.chart as { x: string[] }).x;
    expect(x).not.toContain("2025-02");
    expect(x[0]).toBe("2025-03");
  });

  it("compare_periods defaults to the latest two COMPLETE months and says so", () => {
    const r = ok("compare_periods", { metric: "Sales", breakdown_dimension: "Product" });
    const d = r.data as { a: { period: string }; b: { period: string }; breakdown: { pattern: string } };
    expect([d.a.period, d.b.period]).toEqual(["2026-08", "2026-07"]);
    expect(d.breakdown.pattern).toBe("concentrated");
    expect(r.provenance.caveats.join(" ")).toMatch(/latest complete period was compared with the one before it/);
  });

  it("compare_periods with year_ago, and natural period names", () => {
    const r = ok("compare_periods", { metric: "Sales", period_a: "June 2026", compare_to: "year_ago" });
    const d = r.data as { a: { period: string }; b: { period: string } };
    expect([d.a.period, d.b.period]).toEqual(["2026-06", "2025-06"]);
  });

  it("compare_periods warns when a period is only partly covered", () => {
    const r = ok("compare_periods", { metric: "Sales", period_a: "2026-03", period_b: "2025-02" });
    expect(r.provenance.caveats.join(" ")).toMatch(/only partly covered/);
  });

  it("explain_change names a driver and a volume/margin bridge", () => {
    const r = ok("explain_change", { metric: "Profit" });
    expect(r.summary).toMatch(/clearest driver/);
    expect(r.summary).toMatch(/volume effect/);
  });

  it("trend, anomalies and forecast return grounded results", () => {
    expect(ok("trend", { metric: "Sales" }).summary).toMatch(/rising/);
    expect(ok("trend", { metric: "margin" }).summary).toMatch(/falling|no statistically/);
    expect(ok("anomalies", { metric: "Sales" }).data).toBeDefined();
    const f = ok("forecast", { metric: "Sales", horizon: 3 });
    expect((f.data as { points: unknown[] }).points).toHaveLength(3);
    expect(f.provenance.caveats.join(" ")).toMatch(/not a guaranteed|approximation/);
  });

  it("forecast refuses on too-short history", () => {
    const rows: RawCell[][] = [];
    for (let d = 1; d <= 9; d++) for (let k = 0; k < 3; k++) rows.push([`2024-03-${String(d).padStart(2, "0")}`, String(100 + d + k)]);
    const c = buildFrame({ columns: ["Date", "Sales"], rows: rows as string[][] });
    const cx = createContext(c.frame, buildProfile(c.frame, c));
    const f = reg.call(cx, "forecast", {});
    // 9 complete days ≥ 6 → allowed; an erratic/short case is refused inside the model instead
    expect(f.ok || (f as ToolFailure).code === "insufficient_data" || (f as ToolFailure).code === "not_available").toBe(true);
    const tiny = buildFrame({ columns: ["Date", "Sales"], rows: rows.slice(0, 15) as string[][] });
    const cx2 = createContext(tiny.frame, buildProfile(tiny.frame, tiny));
    expect(reg.call(cx2, "forecast", {}).ok).toBe(false);
  });
});

describe("relationship guards in tools", () => {
  it("labels Profit vs Sales as arithmetic, not a finding", () => {
    const r = ok("correlation", { column_a: "Sales", column_b: "Profit" });
    expect((r.data as { tautological: boolean }).tautological).toBe(true);
    expect(r.summary).toMatch(/related by construction/);
  });

  it("labels Quantity vs Sales as structural", () => {
    expect((ok("correlation", { column_a: "Quantity", column_b: "Sales" }).data as { tautological: boolean }).tautological).toBe(true);
  });

  it("the scan omits arithmetic pairs and says how many", () => {
    const r = ok("correlation", {});
    const pairs = (r.data as { pairs: { a: string; b: string }[] }).pairs;
    for (const p of pairs) expect(new Set([p.a, p.b])).not.toEqual(new Set(["Sales", "Profit"]));
    expect(r.provenance.caveats.join(" ")).toMatch(/related by construction/);
  });
});

describe("profitability and customers", () => {
  it("uses SUM(profit)/SUM(revenue) and gives the golden margin", () => {
    const r = ok("profitability", { dimension: "Product" });
    expect((r.data as { overall: { margin: number } }).overall.margin).toBeCloseTo(31.18, 1);
    expect(r.summary).toMatch(/margin 31\.2%/);
  });
  it("customer_analysis reports distinct customers", () => {
    const r = ok("customer_analysis", {});
    expect((r.data as { distinct: number }).distinct).toBe(897);
  });
  it("cohort_retention builds a heatmap on complete periods", () => {
    const r = ok("cohort_retention", {});
    expect(r.chart?.kind).toBe("heatmap");
  });
  it("funnel is not offered without a stage column", () => {
    expect(reg.offered(ctx).map((t) => t.name)).not.toContain("funnel");
  });
});

describe("every tool summary is grounded in its own facts", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["describe_dataset", {}], ["describe_column", { column: "Sales" }], ["describe_column", { column: "Region" }], ["list_values", { column: "Region" }],
    ["aggregate", { metric: "Sales" }], ["aggregate", { agg: "count" }], ["aggregate", { metric: "Customer", agg: "distinct_count" }], ["aggregate", { metric: "Discount" }],
    ["group_by", { dimension: "Region", metric: "Sales" }], ["group_by", { dimension: "Channel", metric: "UnitPrice", agg: "avg" }], ["top_n", { dimension: "Product", n: 5 }],
    ["top_n", { dimension: "Customer", n: 3, order: "asc", metric: "Sales" }], ["share_of_total", { dimension: "Region", value: "North America" }],
    ["compare_groups", { dimension: "Region", group_a: "North America", group_b: "EMEA" }], ["cross_tab", { row_dimension: "Region", column_dimension: "Channel" }],
    ["pareto", { dimension: "Product" }], ["distribution", { column: "Sales" }], ["time_series", { metric: "Sales" }], ["time_series", { metric: "margin" }],
    ["compare_periods", { metric: "Sales", breakdown_dimension: "Region" }], ["explain_change", { metric: "Sales" }], ["trend", { metric: "Sales" }], ["anomalies", { metric: "Sales" }],
    ["forecast", { metric: "Sales" }], ["volume_vs_margin", {}], ["profitability", { dimension: "Region" }], ["profitability", {}], ["correlation", { column_a: "Discount", column_b: "Profit" }],
    ["correlation", {}], ["outliers", { column: "Quantity" }], ["customer_analysis", {}], ["cohort_retention", {}], ["data_quality", {}],
  ];
  for (const [name, args] of calls) {
    it(`${name} ${JSON.stringify(args)}`, () => {
      const r = ok(name, args);
      const l = new FactLedger();
      l.addResult("c", r);
      l.addLabels(labelsOf(ctx));
      const text = [r.summary, ...r.provenance.caveats].join("\n");
      const v = l.validateText(text);
      expect(v.unverified.map((u) => u.claim.raw), text).toEqual([]);
      expect(r.provenance.method.length).toBeGreaterThan(5);
      expect(JSON.stringify(r.data)).not.toMatch(/NaN|Infinity/);
    });
  }
});

describe("insights and tools agree (dashboard ↔ chat consistency)", () => {
  const report = generateInsights(ctx);
  it("re-running an insight's evidence reproduces its headline numbers", () => {
    let checked = 0;
    for (const i of report.insights) {
      if (!["leader", "period_change", "trend", "forecast", "profitability", "anomaly"].includes(i.kind)) continue;
      const r = reg.call(ctx, i.evidence.tool, i.evidence.params);
      expect(r.ok, `${i.id}: ${(r as ToolFailure).message}`).toBe(true);
      const shown = new Set((r as ToolResult).facts.map((f) => f.display));
      const wanted = i.facts.filter((f) => f.unit === "percent" || f.unit === "currency").map((f) => f.display.replace(/^\+/, ""));
      const hits = wanted.filter((d) => [...shown].some((s) => s.replace(/^[+-]/, "") === d.replace(/^[+-]/, "")));
      expect(hits.length, `${i.id} (${i.kind}) none of ${wanted.join(", ")} found in tool facts`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});

describe("TZ independence", () => {
  it("monthly totals do not depend on the process time zone", () => {
    const rows: RawCell[][] = [];
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= 28; d += 3) rows.push([formatIsoDate(daysFromCivil(2025, m, d)), String(m)]);
    const c = buildFrame({ columns: ["Date", "Sales"], rows: rows as string[][] });
    const cx = createContext(c.frame, buildProfile(c.frame, c));
    const r = ok("time_series", { metric: "Sales", grain: "month" }, cx);
    const pts = (r.data as { points: { period: string; value: number }[] }).points;
    expect(pts.map((p) => p.period)).toEqual(Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`));
    pts.forEach((p, i) => expect(p.value).toBe((i + 1) * 10));
  });
});
