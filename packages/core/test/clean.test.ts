import { describe, expect, it } from "vitest";
import { buildFrame } from "../src/clean";
import { deserializeFrame, serializeFrame, cellValue, NULL_DATE } from "../src/frame";
import { formatIsoDate } from "../src/time";
import { csvToRaw, demoClean } from "./helpers/fixtures";

describe("frame serialisation", () => {
  it("round-trips when the container arrives as a Node Buffer (Buffer#slice is a view, not a copy)", () => {
    const f = demoClean().frame;
    const bytes = serializeFrame(f);
    const asBuffer = Buffer.concat([Buffer.alloc(3), Buffer.from(bytes)]).subarray(3); // unaligned view, like a pooled read
    const back = deserializeFrame(asBuffer);
    expect(back.rowCount).toBe(f.rowCount);
    for (const c of f.columns) {
      for (const i of [0, 1, 777, f.rowCount - 1]) expect(cellValue(back.require(c.name), i), `${c.name}[${i}]`).toEqual(cellValue(c, i));
    }
  });
});

describe("buildFrame — demo dataset", () => {
  it("types the retail columns correctly and quickly", () => {
    const t0 = performance.now();
    const r = demoClean();
    const ms = performance.now() - t0;
    expect(r.frame.rowCount).toBe(6764);
    const kinds = Object.fromEntries(r.frame.columns.map((c) => [c.name, c.kind]));
    expect(kinds).toMatchObject({
      Date: "date", OrderID: "string", Customer: "string", Region: "string", Quantity: "number",
      UnitPrice: "number", Discount: "number", Sales: "number", Cost: "number", Profit: "number",
      MarketingSpend: "number", CustomerSince: "date",
    });
    expect(ms).toBeLessThan(1500);
  });
  it("finds the 14 duplicate rows the prototype found (all columns compared)", () => {
    const r = demoClean();
    expect(r.duplicateRows).toBe(14);
    expect(r.duplicateMask.reduce((a, b) => a + b, 0)).toBe(14);
  });
  it("logs nothing destructive on clean data", () => {
    const r = demoClean();
    expect(r.log.filter((l) => l.kind === "coerce_invalid")).toHaveLength(0);
  });
});

describe("buildFrame — messy data", () => {
  const csv = [
    "  Order Date ,Region,Revenue,Margin %,Notes,Units,Units,Active",
    "05/03/2025, North ,\"$1,200.50\",12%,ok,3,3,Yes",
    "13/03/2025,north,\"$900.00\",15%,N/A,2,2,no",
    "14/03/2025,South,\"(50.00)\",-,fine,1,1,Yes",
    "15/03/2025,South,abc,20%,,4,4,yes",
    ",,,,,,,",
    "16/03/2025,South,\"$2,000\",22%,ok,5,5,No",
    ...Array.from({ length: 8 }, (_, i) => `${17 + i}/03/2025,South,"$${100 + i}.00",${10 + i}%,ok,${i},${i},yes`),
  ].join("\n");
  const r = buildFrame(csvToRaw(csv));
  const col = (n: string) => r.frame.require(n);

  it("normalises headers and drops the empty row, and says so", () => {
    expect(r.frame.names()).toEqual(["Order Date", "Region", "Revenue", "Margin %", "Notes", "Units", "Units_2", "Active"]);
    expect(r.frame.rowCount).toBe(13);
    expect(r.droppedEmptyRows).toBe(1);
    expect(r.log.some((l) => l.kind === "drop_empty_rows")).toBe(true);
    expect(r.log.some((l) => l.kind === "rename_column" && l.column === "Units_2")).toBe(true);
  });
  it("detects day-first from the 13/03 value and stores civil days", () => {
    const c = col("Order Date");
    expect(c.kind).toBe("date");
    expect(formatIsoDate((c as any).values[0])).toBe("2025-03-05");
    expect(r.columns[0]!.dateOrder).toBe("dmy");
  });
  it("parses currency / accounting negatives, blanks the unparsable value and logs it", () => {
    const c = col("Revenue") as any;
    expect(c.kind).toBe("number");
    expect(Array.from(c.values as Float64Array).map((v: number) => (Number.isNaN(v) ? null : v))).toEqual([1200.5, 900, -50, null, 2000, 100, 101, 102, 103, 104, 105, 106, 107]);
    expect(c.meta.currency).toBe("USD");
    const coerced = r.log.find((l) => l.kind === "coerce_invalid" && l.column === "Revenue");
    expect(coerced?.detail).toMatch(/abc/);
  });
  it("stores percent strings as fractions and treats '-' as blank", () => {
    const c = col("Margin %") as any;
    expect(c.kind).toBe("number");
    expect(c.meta.percent).toBe(true);
    expect(c.values[0]).toBeCloseTo(0.12);
    expect(Number.isNaN(c.values[2])).toBe(true);
  });
  it("trims label whitespace but flags (does not merge) case variants", () => {
    const c = col("Region") as any;
    expect(c.dict).toContain("North");
    expect(c.dict).toContain("north");
    expect(r.suggestions.some((s) => s.kind === "normalize_labels" && s.column === "Region")).toBe(true);
  });
  it("stores yes/no as boolean", () => {
    const c = col("Active") as any;
    expect(c.kind).toBe("boolean");
    expect(Array.from(c.values).slice(0, 5)).toEqual([1, 0, 1, 1, 0]);
  });
});

describe("European numbers and ambiguous dates", () => {
  it("reads 1.234,50 columns as numbers (prototype regression: became categorical)", () => {
    const lines = ["v,d"];
    for (let i = 0; i < 40; i++) lines.push(`"${i + 1}.${String((i * 37) % 1000).padStart(3, "0")},50",01/02/2025`);
    const r = buildFrame(csvToRaw(lines.join("\n")));
    expect(r.frame.require("v").kind).toBe("number");
    expect((r.frame.require("v") as any).values[0]).toBe(1000.5 + 0); // "1.000,50"
    expect(r.columns[1]!.dateOrderAmbiguous).toBe(true);
    expect(r.suggestions.some((s) => s.kind === "confirm_date_order")).toBe(true);
  });
});

describe("mixed columns stay text", () => {
  it("keeps a 50/50 numbers-and-text column as string and suggests review", () => {
    const lines = ["x"]; for (let i = 0; i < 20; i++) lines.push(i % 2 ? String(i) : `n${i}`);
    const r = buildFrame(csvToRaw(lines.join("\n")));
    expect(r.frame.require("x").kind).toBe("string");
    expect(r.suggestions.some((s) => s.kind === "review_mixed_type")).toBe(true);
  });
});

describe("frame serialisation", () => {
  it("round-trips a full frame bit-exactly", () => {
    const { frame } = demoClean();
    const back = deserializeFrame(serializeFrame(frame));
    expect(back.rowCount).toBe(frame.rowCount);
    expect(back.names()).toEqual(frame.names());
    for (const c of frame.columns) {
      for (const i of [0, 1, 500, frame.rowCount - 1]) expect(cellValue(back.require(c.name), i)).toEqual(cellValue(c, i));
    }
    expect((back.require("Date") as any).values[0]).not.toBe(NULL_DATE);
  });
});
