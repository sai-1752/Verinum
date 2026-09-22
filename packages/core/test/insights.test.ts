import { describe, expect, it } from "vitest";
import { buildFrame, type RawCell } from "../src/clean";
import { buildProfile } from "../src/profile";
import { createContext, type AnalysisContext } from "../src/context";
import { generateInsights } from "../src/insights";
import { computeKpis } from "../src/kpis";
import { FactLedger } from "../src/grounding/ledger";
import { demoClean } from "./helpers/fixtures";
import { daysFromCivil, formatIsoDate } from "../src/time";
import type { StringColumn } from "../src/frame";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const ctxOf = (columns: string[], rows: RawCell[][]): AnalysisContext => {
  const clean = buildFrame({ columns, rows: rows.map((r) => r.map((c) => (c === null ? "" : String(c)))) });
  return createContext(clean.frame, buildProfile(clean.frame, clean));
};
const labelsOf = (ctx: AnalysisContext): string[] => [
  ...ctx.frame.names(),
  ...ctx.frame.columns.flatMap((c) => (c.kind === "string" ? (c as StringColumn).dict : [])),
];

describe("insights on the demo dataset", () => {
  const clean = demoClean();
  const profile = buildProfile(clean.frame, clean);
  const ctx = createContext(clean.frame, profile);
  const report = generateInsights(ctx);

  it("is deterministic: same data ⇒ identical ids, order and text", () => {
    const again = generateInsights(createContext(clean.frame, profile));
    expect(again.insights.map((i) => i.id)).toEqual(report.insights.map((i) => i.id));
    expect(again.insights.map((i) => i.summary)).toEqual(report.insights.map((i) => i.summary));
  });

  it("is ranked by a transparent score with all six factors", () => {
    const scores = report.insights.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const i of report.insights) {
      expect(Object.keys(i.factors).sort()).toEqual(["completeness", "confidence", "magnitude", "novelty", "relevance", "significance"]);
      for (const v of Object.values(i.factors)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
      expect(i.score).toBeGreaterThan(0);
      expect(i.score).toBeLessThanOrEqual(100);
    }
  });

  it("grounds every number in its title, summary, detail and caveats in its own facts", () => {
    for (const i of report.insights) {
      const l = new FactLedger();
      l.addFacts(i.id, i.facts);
      l.addLabels(labelsOf(ctx));
      const text = [i.title, i.summary, ...i.detail, ...i.caveats].join("\n");
      const v = l.validateText(text);
      expect(v.unverified.map((u) => `${i.id}: ${u.claim.raw}`), text).toEqual([]);
    }
  });

  it("grounds the executive summary in its facts", () => {
    const l = new FactLedger();
    l.addFacts("sum", report.summary.facts);
    l.addLabels(labelsOf(ctx));
    const v = l.validateText([report.summary.headline, ...report.summary.bullets.map((b) => b.text), ...report.summary.caveats].join("\n"));
    expect(v.unverified.map((u) => u.claim.raw)).toEqual([]);
  });

  it("never anchors a comparison on the partial first month", () => {
    const pc = report.insights.find((i) => i.kind === "period_change");
    expect(pc).toBeDefined();
    expect(pc!.summary).not.toContain("2025-02");
    for (const i of report.insights) expect(i.facts.filter((f) => f.unit === "date").map((f) => f.display)).not.toContain("2025-02");
  });

  it("reports golden KPI values", () => {
    const k = Object.fromEntries(computeKpis(ctx).map((x) => [x.id, x]));
    expect(k["rows"]!.value).toBe(6764);
    expect(k["m:Sales"]!.value).toBeCloseTo(3225540.86, 1);
    expect(k["margin"]!.value).toBeCloseTo(31.18, 1);
    expect(k["margin"]!.display).toBe("31.2%");
    expect(k["customers"]!.value).toBe(897);
    expect(k["m:Sales"]!.delta!.currentPeriod).toBe("2026-08");
    expect(k["m:UnitPrice"]!.agg).toBe("avg"); // prices are averaged, never summed
  });

  it("does not offer tautological correlations (quantity ↔ sales, profit ↔ sales)", () => {
    const corr = report.insights.filter((i) => i.kind === "correlation").map((i) => new Set(i.columns));
    for (const c of corr) {
      expect(c.has("Quantity") && c.has("Sales")).toBe(false);
      expect(c.has("Sales") && c.has("Profit")).toBe(false);
      expect(c.has("Profit") && c.has("Cost")).toBe(false);
    }
  });

  it("identifies the leader by the concentrated dimension and the profit-vs-revenue gap", () => {
    expect(report.insights.some((i) => i.kind === "leader" && i.title.includes("Enterprise"))).toBe(true);
    expect(report.insights.some((i) => i.kind === "profitability")).toBe(true);
  });

  it("every insight cites a reproducible tool and carries follow-up questions", () => {
    for (const i of report.insights) {
      expect(i.evidence.tool).toMatch(/^[a-z_]+$/);
      expect(i.followUps.length).toBeGreaterThan(0);
      expect(i.method.length).toBeGreaterThan(10);
    }
  });
});

describe("insight guards", () => {
  it("does not call an evenly split dimension concentrated (safeguard 6)", () => {
    const r = rng(11);
    const rows: RawCell[][] = [];
    for (let i = 0; i < 600; i++) rows.push([`Store ${(i % 8) + 1}`, 100 + Math.round(r() * 10)]);
    const ctx = ctxOf(["Region", "Sales"], rows.map(([a, b]) => [String(a).replace("Store", "Area"), b as number]));
    const rep = generateInsights(ctx);
    expect(rep.insights.filter((i) => i.kind === "concentration" || i.kind === "leader")).toEqual([]);
  });

  it("flags genuine concentration and names the top groups", () => {
    const rows: RawCell[][] = [];
    const sizes = [900, 500, 100, 60, 50, 40, 30, 20];
    sizes.forEach((v, k) => { for (let i = 0; i < 20; i++) rows.push([`Vendor ${String.fromCharCode(65 + k)}`, v / 20 + (i % 3)]); });
    const rep = generateInsights(ctxOf(["Category", "Revenue"], rows));
    const c = rep.insights.find((i) => i.kind === "concentration");
    expect(c).toBeDefined();
    expect(c!.summary).toContain("Vendor A");
  });

  it("does not report a trend for a flat, noisy series", () => {
    const r = rng(5);
    const rows: RawCell[][] = [];
    for (let m = 0; m < 24; m++) for (let d = 0; d < 20; d++) rows.push([formatIsoDate(daysFromCivil(2024 + Math.floor(m / 12), (m % 12) + 1, 1 + d)), 100 + Math.round((r() - 0.5) * 20)]);
    const rep = generateInsights(ctxOf(["Date", "Sales"], rows));
    expect(rep.insights.filter((i) => i.kind === "trend")).toEqual([]);
  });

  it("reports a genuine trend using complete periods only, with the fitted change", () => {
    const rows: RawCell[][] = [];
    for (let m = 0; m < 24; m++) for (let d = 0; d < 25; d++) rows.push([formatIsoDate(daysFromCivil(2024 + Math.floor(m / 12), (m % 12) + 1, 1 + d)), 100 + m * 6 + (d % 5)]);
    const rep = generateInsights(ctxOf(["Date", "Sales"], rows));
    const t = rep.insights.find((i) => i.kind === "trend");
    expect(t).toBeDefined();
    expect(t!.title).toContain("up");
    expect(t!.summary).toMatch(/rose/);
  });

  it("does not compute margin insights from a margin-% column (safeguard 8/10)", () => {
    const r = rng(9);
    const rows: RawCell[][] = [];
    for (let i = 0; i < 300; i++) rows.push([["A", "B", "C"][i % 3]!, 100 + Math.round(r() * 50), (0.2 + r() * 0.1).toFixed(3)]);
    const ctx = ctxOf(["Region", "Revenue", "Profit Margin"], rows);
    expect(ctx.profile.capabilities.margin).toBe(false);
    expect(generateInsights(ctx).insights.filter((i) => i.kind === "profitability" || i.kind === "loss_makers" || i.kind === "margin_trend")).toEqual([]);
  });

  it("yields only quality findings for a tiny dataset", () => {
    const rep = generateInsights(ctxOf(["A", "B"], [["x", 1], ["y", 2], ["x", 3]]));
    expect(rep.insights.filter((i) => i.kind !== "quality")).toEqual([]);
  });

  it("returns an empty, well-formed report for zero rows", () => {
    const clean = buildFrame({ columns: ["A"], rows: [] });
    const ctx = createContext(clean.frame, buildProfile(clean.frame, clean));
    const rep = generateInsights(ctx);
    expect(rep.insights).toEqual([]);
    expect(rep.summary.headline).toContain("0 rows");
  });
});
