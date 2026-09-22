import { describe, expect, it } from "vitest";
import {
  civilFromDays, daysFromCivil, formatIsoDate, isoWeekday, ordinalFromKey, parseIsoDate,
  periodEndDays, periodKey, periodOrdinal, periodStartDays, pickGrain,
} from "../src/time";

describe("civil date arithmetic", () => {
  it("round-trips every day across 1900-2100", () => {
    for (let d = daysFromCivil(1900, 1, 1); d <= daysFromCivil(2100, 12, 31); d++) {
      const c = civilFromDays(d);
      expect(daysFromCivil(c.y, c.m, c.d)).toBe(d);
    }
  });
  it("knows the epoch, leap years and weekdays", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(formatIsoDate(daysFromCivil(2024, 2, 29))).toBe("2024-02-29");
    expect(parseIsoDate("2023-02-29")).toBeNull();
    expect(isoWeekday(daysFromCivil(1970, 1, 1))).toBe(3); // Thursday
    expect(isoWeekday(daysFromCivil(2026, 9, 21))).toBe(0); // Monday
  });
});

describe("periods", () => {
  it("month/quarter/year keys and gap-free ordinals", () => {
    const d = daysFromCivil(2025, 12, 31);
    expect(periodKey(periodOrdinal(d, "month"), "month")).toBe("2025-12");
    expect(periodKey(periodOrdinal(d, "quarter"), "quarter")).toBe("2025-Q4");
    expect(periodOrdinal(daysFromCivil(2026, 1, 1), "month") - periodOrdinal(d, "month")).toBe(1);
    expect(periodOrdinal(daysFromCivil(2026, 1, 1), "quarter") - periodOrdinal(d, "quarter")).toBe(1);
  });
  it("weeks start on Monday", () => {
    const wed = daysFromCivil(2026, 9, 23);
    const ord = periodOrdinal(wed, "week");
    expect(formatIsoDate(periodStartDays(ord, "week"))).toBe("2026-09-21");
    expect(formatIsoDate(periodEndDays(ord, "week"))).toBe("2026-09-27");
    expect(ordinalFromKey("2026-09-21", "week")).toBe(ord);
  });
  it("start/end/key round trip for every grain", () => {
    for (const g of ["day", "week", "month", "quarter", "year"] as const) {
      const ord = periodOrdinal(daysFromCivil(2025, 8, 17), g);
      expect(periodOrdinal(periodStartDays(ord, g), g)).toBe(ord);
      expect(periodOrdinal(periodEndDays(ord, g), g)).toBe(ord);
      expect(ordinalFromKey(periodKey(ord, g), g)).toBe(ord);
    }
  });
  it("picks grains like the prototype", () => {
    expect([30, 100, 600, 2000].map(pickGrain)).toEqual(["day", "week", "month", "quarter"]);
  });
});

// Regression: safeguards 1-2 (timezone / phantom periods). The suite is executed under several
// TZ values by `npm run test:tz`; the assertions below must hold in all of them.
describe("timezone independence", () => {
  it("a date-only ISO string always lands on its own calendar day", () => {
    const p = parseIsoDate("2025-03-01")!;
    expect(formatIsoDate(p)).toBe("2025-03-01");
    expect(periodKey(periodOrdinal(p, "month"), "month")).toBe("2025-03"); // not 2025-02
  });
});
