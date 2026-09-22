import { describe, expect, it } from "vitest";
import { buildFrame } from "../src/clean";
import { dropColumns, normalizeLabels, removeDuplicateRows } from "../src/clean-actions";
import { cellValue } from "../src/frame";
import { formatIsoDate } from "../src/time";
import { demoClean } from "./helpers/fixtures";

describe("cleaning actions", () => {
  it("removes exactly the 14 duplicates of the demo dataset and keeps first occurrences", () => {
    const r = demoClean();
    const out = removeDuplicateRows(r.frame);
    expect(out.frame.rowCount).toBe(6764 - 14);
    expect(out.log[0]!.affected).toBe(14);
    expect(out.log[0]!.kind).toBe("remove_duplicates");
    expect(removeDuplicateRows(out.frame).log).toHaveLength(0);
  });

  it("merges label variants that differ only by case/spacing, keeping the most frequent spelling", () => {
    const raw = { columns: ["Region", "Sales"], rows: [["North", 1], ["north", 2], ["North ", 3], ["NORTH", 4], ["South", 5], ["South", 6], [null, 7]] as never };
    const f = buildFrame(raw).frame;
    const out = normalizeLabels(f);
    const col = out.frame.string("Region");
    expect(col.dict.sort()).toEqual(["North", "South"]);
    expect(out.log[0]!.detail).toMatch(/4 → 2/);
    const labels = Array.from({ length: 7 }, (_, i) => cellValue(col, i));
    expect(labels).toEqual(["North", "North", "North", "North", "South", "South", null]);
  });

  it("does not merge genuinely different labels", () => {
    const f = buildFrame({ columns: ["Region"], rows: [["North"], ["North East"], ["South"]] }).frame;
    expect(normalizeLabels(f).log).toHaveLength(0);
  });

  it("drops named columns only", () => {
    const f = demoClean().frame;
    const out = dropColumns(f, ["Cost", "nope"]);
    expect(out.frame.has("Cost")).toBe(false);
    expect(out.frame.columns.length).toBe(f.columns.length - 1);
  });
});

describe("dateOrders override", () => {
  const raw = { columns: ["When", "V"], rows: [["03/04/2025", 1], ["05/06/2025", 2], ["07/08/2025", 3], ["01/02/2025", 4]] };
  it("flags ambiguity by default and honours a confirmed order", () => {
    const auto = buildFrame(raw);
    expect(auto.columns.find((c) => c.name === "When")!.dateOrderAmbiguous).toBe(true);
    const dmy = buildFrame(raw, { dateOrders: { When: "dmy" } });
    const info = dmy.columns.find((c) => c.name === "When")!;
    expect(info.dateOrder).toBe("dmy");
    expect(info.dateOrderAmbiguous).toBe(false);
    expect(formatIsoDate(dmy.frame.date("When").values[0]!)).toBe("2025-04-03");
    const mdy = buildFrame(raw, { dateOrders: { When: "mdy" } });
    expect(formatIsoDate(mdy.frame.date("When").values[0]!)).toBe("2025-03-04");
  });
});
