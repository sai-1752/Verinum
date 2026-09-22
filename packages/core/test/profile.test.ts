import { describe, expect, it } from "vitest";
import { buildFrame } from "../src/clean";
import { buildProfile } from "../src/profile";
import { columnOf } from "../src/types";
import { demoClean } from "./helpers/fixtures";

/** Small deterministic PRNG so fixtures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const pad = (n: number) => String(n).padStart(2, "0");

function profileOf(columns: string[], rows: (string | number)[][]) {
  const clean = buildFrame({ columns, rows: rows.map((r) => r.map(String)) });
  return buildProfile(clean.frame, clean);
}

describe("profiler on the demo dataset (parity with the prototype)", () => {
  const clean = demoClean();
  const p = buildProfile(clean.frame, clean);

  it("classifies columns by type, role and meaning", () => {
    const t = (n: string) => columnOf(p, n)!;
    expect(t("Date").role).toBe("time");
    expect(t("OrderID").type).toBe("identifier");
    expect(t("OrderID").analyzable).toBe(false);
    expect(t("Customer").meaning).toBe("customer");
    expect(t("Product").meaning).toBe("product");
    expect(t("Region").chartDimension).toBe(true);
    expect(t("Sales")).toMatchObject({ type: "numeric", meaning: "revenue", additive: true, defaultAgg: "sum", unit: "currency" });
    expect(t("Profit")).toMatchObject({ meaning: "profit", additive: true });
    expect(t("MarketingSpend").meaning).toBe("marketing"); // marketing wins over cost
  });

  it("treats prices and discounts as non-additive (averaged, never summed)", () => {
    expect(columnOf(p, "UnitPrice")).toMatchObject({ additive: false, defaultAgg: "avg" });
    expect(columnOf(p, "Discount")).toMatchObject({ additive: false, defaultAgg: "avg", unit: "percent" });
  });

  it("prefers the event date over the attribute date", () => {
    expect(p.primaryDate).toBe("Date");
    expect(columnOf(p, "CustomerSince")!.date!.kind).toBe("attribute");
  });

  it("trims the partial first month from the calendar", () => {
    expect(p.calendar).toMatchObject({ grain: "month", trimmedStart: 1, firstCompleteKey: "2025-03", completePeriods: 18 });
    expect(p.calendar!.notes.join(" ")).toMatch(/partial/i);
  });

  it("finds the exact duplicates across all columns", () => {
    expect(p.duplicateRows).toBe(14);
    expect(p.rowCount).toBe(6764); // 6,750 distinct orders + 14 exact repeats
  });

  it("recovers the profit identity Profit = Sales − Cost", () => {
    expect(p.relations.some((r) => r.kind === "difference" && r.result === "Profit")).toBe(true);
  });

  it("scores quality like the prototype (74) and labels it", () => {
    expect(p.quality.score).toBeGreaterThanOrEqual(72);
    expect(p.quality.score).toBeLessThanOrEqual(76);
    expect(p.quality.label).toBe("Fair");
    expect(p.quality.issues.some((i) => i.kind === "duplicate_rows")).toBe(true);
  });

  it("matches the golden totals", () => {
    expect(columnOf(p, "Sales")!.stats!.sum).toBeCloseTo(3225540.86, 1);
  });

  it("gates capabilities from the data, with reasons for what is off", () => {
    const c = p.capabilities;
    expect(c).toMatchObject({ leadMetric: "Sales", revenue: "Sales", profit: "Profit", margin: true, timeSeries: true, forecast: true, cohort: true });
    expect(c.seasonality).toBe(false);
    expect(c.unavailable.seasonality).toMatch(/two full cycles/);
    expect(c.stage).toBeNull();
    expect(c.unavailable.funnel).toMatch(/no stage/i);
  });
});

describe("profiler safeguards (regressions from the prototype)", () => {
  it("classifies sentences as free text, not identifiers (safeguard 9)", () => {
    const r = rng(1);
    const words = ["great", "service", "arrived", "late", "product", "broken", "would", "buy", "again", "support", "helpful", "slow"];
    const rows = Array.from({ length: 60 }, (_, i) => {
      const sentence = Array.from({ length: 8 }, () => words[Math.floor(r() * words.length)]).join(" ") + ` #${i}`;
      return [i % 3 === 0 ? "A" : "B", sentence, Math.round(r() * 100)];
    });
    const p = profileOf(["Tier", "Feedback", "Amount"], rows);
    const fb = columnOf(p, "Feedback")!;
    expect(fb.type).toBe("text");
    expect(fb.role).toBe("text");
    expect(fb.analyzable).toBe(false);
    expect(p.capabilities.groupable).not.toContain("Feedback");
    expect(p.capabilities.dimensions).not.toContain("Feedback");
  });

  it("does not let a 'customer_note' column pose as a customer", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`Please call back about invoice number ${i} this week`, i]);
    const p = profileOf(["customer_note", "Amount"], rows);
    expect(columnOf(p, "customer_note")!.meaning).toBeNull();
    expect(p.capabilities.customer).toBeNull();
  });

  it("marks share, rate and percentage columns non-additive", () => {
    const r = rng(2);
    const rows = Array.from({ length: 50 }, (_, i) => [
      `Item ${i}`, (0.02 + r() * 0.04).toFixed(3), (r() * 100).toFixed(1), (0.3 + r() * 0.2).toFixed(2), Math.round(100 + r() * 900),
    ]);
    const p = profileOf(["Item", "Conversion Rate", "Score", "Margin", "Revenue"], rows);
    expect(columnOf(p, "Conversion Rate")).toMatchObject({ additive: false, defaultAgg: "avg" });
    expect(columnOf(p, "Score")).toMatchObject({ additive: false, defaultAgg: "avg" });
    expect(columnOf(p, "Margin")).toMatchObject({ meaning: "margin", additive: false });
    expect(columnOf(p, "Revenue")).toMatchObject({ additive: true });
    expect(p.capabilities.leadMetric).toBe("Revenue");
  });

  it("detects a column of shares that sums to a whole", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`Region ${i}`, 0.1, i * 10 + 5]);
    const p = profileOf(["Name", "Weight", "Value"], rows);
    expect(columnOf(p, "Weight")!.additive).toBe(false);
  });

  it("treats a gap-free integer sequence as an identifier, not a measure", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i + 1, (i * 7) % 13 + 1]);
    const p = profileOf(["Row", "Amount"], rows);
    expect(columnOf(p, "Row")!.type).toBe("identifier");
    expect(p.capabilities.measures).not.toContain("Row");
    expect(p.capabilities.leadMetric).toBe("Amount");
  });

  it("does not offer near-unique captions as chart dimensions", () => {
    const rows = Array.from({ length: 80 }, (_, i) => [["North", "South", "East"][i % 3]!, `Photo taken near the old harbour number ${i}`, i]);
    const p = profileOf(["Region", "Caption", "Amount"], rows);
    expect(columnOf(p, "Caption")!.chartDimension).toBe(false);
    expect(p.capabilities.dimensions).toEqual(["Region"]);
  });

  it("does not sum calendar-part columns", () => {
    const rows = Array.from({ length: 48 }, (_, i) => [2023 + Math.floor(i / 12), (i % 12) + 1, (100 + i * 3.7).toFixed(1)]);
    const p = profileOf(["Year", "Month", "Sales"], rows);
    expect(columnOf(p, "Month")!.subtypes).toContain("calendar_part");
    expect(p.capabilities.measures).toEqual(["Sales"]);
  });

  const identityRows = () => {
    const r = rng(3);
    return Array.from({ length: 60 }, () => {
      const sales = 200 + Math.round(r() * 800), part = Math.round(sales * (0.3 + r() * 0.3));
      return [sales, part, sales - part];
    });
  };

  it("infers profit from the arithmetic identity when only the cost is named", () => {
    const p = profileOf(["Sales", "Cost", "Result"], identityRows());
    expect(columnOf(p, "Result")!.meaning).toBe("profit");
    expect(columnOf(p, "Result")!.reasons.join(" ")).toMatch(/≈/);
    expect(p.capabilities.margin).toBe(true);
  });

  it("infers cost from the arithmetic identity when only the profit is named", () => {
    const p = profileOf(["Sales", "Outlay", "Profit"], identityRows());
    expect(columnOf(p, "Outlay")!.meaning).toBe("cost");
    expect(columnOf(p, "Profit")!.meaning).toBe("profit");
  });

  it("leaves two unnamed parts unlabelled instead of guessing which is profit", () => {
    const p = profileOf(["Sales", "Overhead", "Result"], identityRows());
    expect(columnOf(p, "Overhead")!.meaning).toBeNull();
    expect(columnOf(p, "Result")!.meaning).toBeNull();
    expect(p.capabilities.margin).toBe(false);
  });

  it("does not pick a signup/attribute date as the time axis", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`2020-01-${pad((i % 28) + 1)}`, i * 3 + 1]);
    const p = profileOf(["Signup Date", "Amount"], rows);
    expect(p.primaryDate).toBeNull();
    expect(p.capabilities.timeSeries).toBe(false);
    expect(p.capabilities.unavailable.forecast).toMatch(/date or time field/);
  });
});

describe("capability gating", () => {
  it("explains why forecasting is off with too little history", () => {
    const rows: (string | number)[][] = [];
    for (let d = 1; d <= 5; d++) for (let k = 0; k < 4; k++) rows.push([`2024-03-${pad(d + 10)}`, 100 + d * 5 + k]);
    const p = profileOf(["Date", "Sales"], rows);
    expect(p.calendar).toMatchObject({ grain: "day", completePeriods: 5 });
    expect(p.capabilities.forecast).toBe(false);
    expect(p.capabilities.unavailable.forecast).toMatch(/at least 6/);
    expect(p.capabilities.unavailable.seasonality).toBeDefined();
  });

  it("has no time capabilities and a count-only profile when nothing is numeric", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [["a", "b", "c"][i % 3]!, ["x", "y"][i % 2]!]);
    const p = profileOf(["Group", "Kind"], rows);
    expect(p.capabilities.measures).toEqual([]);
    expect(p.capabilities.leadMetric).toBeNull();
    expect(p.capabilities.unavailable.measures).toBeDefined();
  });
});
