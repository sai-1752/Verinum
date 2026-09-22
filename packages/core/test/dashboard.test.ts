import { describe, expect, it } from "vitest";
import { buildProfile } from "../src/profile";
import { createContext } from "../src/context";
import { createToolRegistry } from "../src/tools";
import { materializeDashboard, planDashboard } from "../src/dashboard";
import { FactLedger } from "../src/grounding/ledger";
import type { StringColumn } from "../src/frame";
import { demoClean } from "./helpers/fixtures";

const clean = demoClean();
const profile = buildProfile(clean.frame, clean);
const ctx = createContext(clean.frame, profile);
const reg = createToolRegistry();
const labels = [...ctx.frame.names(), ...ctx.frame.columns.flatMap((x) => (x.kind === "string" ? (x as StringColumn).dict : []))];

describe("dashboard planning", () => {
  const plan = planDashboard(ctx);
  it("is deterministic and derived from capabilities", () => {
    expect(planDashboard(ctx)).toEqual(plan);
    const ids = plan.widgets.map((w) => w.id);
    expect(ids).toContain("trend");
    expect(ids).toContain("forecast");
    expect(ids).toContain("margin-trend");
    expect(ids).toContain("top-products");
    expect(ids).not.toContain("funnel"); // no stage column in the demo
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("offers bounded categorical filters and the date range", () => {
    expect(plan.filters[0]).toMatchObject({ kind: "date", column: "Date", min: "2025-02-28", max: "2026-08-30" });
    const region = plan.filters.find((f) => f.column === "Region")!;
    expect(region.values!.map((v) => v.value)).toContain("North America");
  });
});

describe("dashboard materialisation", () => {
  const plan = planDashboard(ctx);
  const view = materializeDashboard(ctx, plan.widgets, reg);
  it("renders every widget with a chart and provenance, or an explicit reason", () => {
    expect(view.widgets).toHaveLength(plan.widgets.length);
    for (const w of view.widgets) {
      if (w.status === "ok") { expect(w.chart, w.spec.id).toBeTruthy(); expect(w.provenance?.tool).toBe(w.spec.tool); }
      else expect(w.reason!.length, w.spec.id).toBeGreaterThan(5);
    }
    expect(view.widgets.filter((w) => w.status === "ok").length).toBeGreaterThanOrEqual(8);
    expect(view.kpis.length).toBeGreaterThan(2);
  });
  it("every widget summary is grounded in its own facts", () => {
    for (const w of view.widgets.filter((x) => x.status === "ok")) {
      const l = new FactLedger();
      l.addFacts(w.spec.id, w.facts!);
      l.addLabels(labels);
      const v = l.validateText([w.summary!, ...w.provenance!.caveats].join("\n"));
      expect(v.unverified.map((u) => u.claim.raw), w.spec.id).toEqual([]);
    }
  });
  it("filters narrow every widget and KPI at once, and report the scope", () => {
    const f = materializeDashboard(ctx, plan.widgets, reg, { filters: [{ column: "Region", op: "eq", value: "EMEA" }] });
    expect(f.rowsInScope).toBe(1999);
    expect(f.totalRows).toBe(6764);
    expect(f.appliedFilters).toEqual(["Region = EMEA"]);
    const total = view.kpis.find((k) => k.id.startsWith("m:"))!.value!;
    expect(f.kpis.find((k) => k.id.startsWith("m:"))!.value!).toBeLessThan(total);
    for (const w of f.widgets.filter((x) => x.status === "ok")) expect(w.provenance!.rowsConsidered, w.spec.id).toBeLessThanOrEqual(1999);
  });
  it("a date range narrows by civil date", () => {
    const f = materializeDashboard(ctx, plan.widgets, reg, { dateFrom: "2026-01", dateTo: "2026-03" });
    expect(f.rowsInScope).toBeGreaterThan(0);
    expect(f.rowsInScope).toBeLessThan(6764);
  });
  it("an empty selection yields explicit reasons, not blank or fake charts", () => {
    const f = materializeDashboard(ctx, plan.widgets, reg, { filters: [{ column: "Region", op: "eq", value: "Atlantis" }] });
    expect(f.rowsInScope).toBe(0);
    expect(f.widgets.every((w) => w.status === "unavailable" && !!w.reason)).toBe(true);
    expect(f.notes[0]).toMatch(/No rows/);
  });
});
