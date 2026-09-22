/**
 * Regression tests for the prototype's hard-won safeguards that are not covered by a more specific
 * suite. Each test names the failure it prevents. (Others: timezone → time.test.ts; concentration on
 * even data, tautological correlations, additive-only profit → insights.test.ts; free-text identity,
 * share/rate/caption guards → profile.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { buildFrame } from "../src/clean";
import { buildProfile } from "../src/profile";
import { createContext } from "../src/context";
import { createToolRegistry } from "../src/tools";
import { generateInsights } from "../src/insights";
import { computeKpis } from "../src/kpis";
import type { ToolResult } from "../src/facts";

function ctxOf(header: string[], rows: (string | number)[][]) {
  const clean = buildFrame({ columns: header, rows: rows.map((r) => r.map(String)) });
  return createContext(clean.frame, buildProfile(clean.frame, clean));
}
const reg = createToolRegistry();

/** 30 rows/month for 2025-01…2025-12 with an optional extra tail. */
function monthly(opts: { skip?: number[]; tail?: { date: string; rows: number }[]; blankRegionEvery?: number } = {}) {
  const rows: (string | number)[][] = [];
  let id = 0;
  for (let m = 1; m <= 12; m++) {
    if (opts.skip?.includes(m)) continue;
    for (let d = 0; d < 30; d++) {
      const day = String(1 + (d % 28)).padStart(2, "0");
      const region = opts.blankRegionEvery && id % opts.blankRegionEvery === 0 ? "" : ["East", "West", "North"][id % 3]!;
      rows.push([`2025-${String(m).padStart(2, "0")}-${day}`, region, 100 + (id % 7) * 5 + m, 60 + (id % 5) * 3]);
      id++;
    }
  }
  for (const t of opts.tail ?? []) for (let k = 0; k < t.rows; k++) rows.push([t.date, "East", 100, 60]);
  return ctxOf(["Date", "Region", "Sales", "Cost"], rows);
}

describe("phantom periods", () => {
  it("a month with no data is a gap, not a zero-sales period or a complete period", () => {
    const ctx = monthly({ skip: [6] });
    const cal = ctx.profile.calendar!;
    expect(cal.missingPeriods).toBe(1);
    const r = reg.call(ctx, "time_series", { metric: "Sales" }) as ToolResult;
    expect(r.ok).toBe(true);
    const points = (r.data as { points: { period: string; value: number }[] }).points;
    expect(points.map((p) => p.period)).not.toContain("2025-06");
    expect(points.every((p) => p.value > 0)).toBe(true);
  });
  it("period-over-period change is never computed across a gap", () => {
    const ctx = monthly({ skip: [6] });
    const r = reg.call(ctx, "time_series", { metric: "Sales" }) as ToolResult;
    const points = (r.data as { points: { period: string; pctChange: number | null }[] }).points;
    expect(points.find((p) => p.period === "2025-07")!.pctChange).toBeNull();
  });
});

describe("incomplete periods and extreme percentage headlines", () => {
  const ctx = monthly({ tail: [{ date: "2026-01-02", rows: 3 }] });
  it("a sliver of a new month is trimmed from the calendar and flagged, not treated as the latest period", () => {
    expect(ctx.profile.calendar!.lastCompleteKey).toBe("2025-12");
    expect(ctx.profile.calendar!.trimmedEnd).toBe(1);
  });
  it("KPI deltas compare the last two complete months", () => {
    const k = computeKpis(ctx, { max: 3 }).find((x) => x.id.startsWith("m:"))!;
    expect(k.delta!.currentPeriod).toBe("2025-12");
    expect(k.delta!.previousPeriod).toBe("2025-11");
  });
  it("no insight headlines a huge drop caused by the partial month", () => {
    const report = generateInsights(ctx);
    const text = report.insights.map((i) => `${i.title} ${i.summary}`).join(" ");
    expect(text).not.toMatch(/9\d(\.\d)?%|8\d(\.\d)?%/); // a 3-row month against a 30-row month would read as ≈ −90%
    for (const i of report.insights.filter((x) => x.kind === "period_change")) expect(i.summary).not.toMatch(/2026-01/);
  });
  it("compare_periods warns instead of quietly comparing a partial month", () => {
    const r = reg.call(ctx, "compare_periods", { metric: "Sales", period_a: "2026-01", period_b: "2025-12" }) as ToolResult;
    expect(r.ok).toBe(true);
    expect(r.provenance.caveats.join(" ")).toMatch(/only partly covered/);
  });
  it("by default it never uses the partial month at all", () => {
    const r = reg.call(ctx, "compare_periods", { metric: "Sales" }) as ToolResult;
    expect((r.data as { a: { period: string } }).a.period).toBe("2025-12");
  });
});

describe("blank groups", () => {
  const ctx = monthly({ blankRegionEvery: 4 });
  it("a blank category is never ranked as a leader, and is reported", () => {
    const r = reg.call(ctx, "top_n", { dimension: "Region", metric: "Sales", n: 5 }) as ToolResult;
    expect(r.ok).toBe(true);
    const keys = (r.data as { rows: { key: string }[] }).rows.map((x) => x.key);
    expect(keys).not.toContain("");
    expect(keys).not.toContain("(blank)");
    expect(r.provenance.caveats.join(" ")).toMatch(/no Region/);
  });
  it("insights do not name the blank group", () => {
    for (const i of generateInsights(ctx).insights) expect(`${i.title} ${i.summary}`).not.toMatch(/\(blank\)|""/);
  });
});

describe("margin calculation", () => {
  it("is Σprofit ÷ Σrevenue, not the average of row-level margins", () => {
    // one big low-margin sale and many small high-margin sales: the two definitions disagree strongly
    const rows: (string | number)[][] = [];
    for (let m = 1; m <= 8; m++) {
      rows.push([`2025-0${m}-05`, "A", 10000, 9000, 1000]);
      for (let k = 0; k < 20; k++) rows.push([`2025-0${m}-${String(10 + k).padStart(2, "0")}`, "B", 100, 20, 80]);
    }
    const ctx = ctxOf(["Date", "Segment", "Sales", "Cost", "Profit"], rows);
    const r = reg.call(ctx, "aggregate", { metric: "Profit" }) as ToolResult;
    const profit = (r.data as { value: number }).value;
    const s = reg.call(ctx, "aggregate", { metric: "Sales" }) as ToolResult;
    const sales = (s.data as { value: number }).value;
    const weighted = (profit / sales) * 100;
    const rowAvg = ((1000 / 10000 + 19 * 0 + 20 * (80 / 100)) / 21) * 100; // ≈ 76%
    expect(weighted).toBeLessThan(25);
    expect(rowAvg).toBeGreaterThan(70);
    const ts = reg.call(ctx, "time_series", { metric: "margin" }) as ToolResult;
    const first = (ts.data as { points: { value: number }[] }).points[0]!.value;
    expect(first).toBeCloseTo(((1000 + 20 * 80) / (10000 + 20 * 100)) * 100, 1);
    const prof = reg.call(ctx, "profitability", { dimension: "Segment" }) as ToolResult;
    expect(prof.ok).toBe(true);
  });
});

describe("forecast gating", () => {
  it("refuses to forecast from fewer than six complete periods, with a reason", () => {
    const rows: (string | number)[][] = [];
    for (let d = 1; d <= 5; d++) for (let k = 0; k < 10; k++) rows.push([`2025-03-0${d}`, "East", 100 + d + k, 50]);
    const ctx = ctxOf(["Date", "Region", "Sales", "Cost"], rows);
    expect(ctx.profile.calendar!.grain).toBe("day");
    expect(ctx.profile.capabilities.forecast).toBe(false);
    const r = reg.call(ctx, "forecast", { metric: "Sales" });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/at least 6/);
  });
});
