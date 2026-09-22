import { describe, expect, it } from "vitest";
import { detectDateOrder, detectDecimalLocale, isNullToken, parseBoolToken, parseDateCell, parseNumberCell } from "../src/values";
import { formatIsoDate } from "../src/time";

const num = (s: string, l: "us" | "eu" = "us") => parseNumberCell(s, l)?.value ?? null;
const date = (s: string, o: "dmy" | "mdy" = "mdy") => { const p = parseDateCell(s, o); return p ? formatIsoDate(p.days) : null; };

describe("parseNumberCell", () => {
  it("parses plain, grouped, currency, percent and accounting negatives", () => {
    expect(num("1234.5")).toBe(1234.5);
    expect(num("1,234,567.89")).toBe(1234567.89);
    expect(num("$1,234.50")).toBe(1234.5);
    expect(num("₹ 1,23,456.00")).toBe(123456);
    expect(num("12,34,567")).toBe(1234567);
    expect(num("(500)")).toBe(-500);
    expect(num("−42")).toBe(-42);
    expect(num("12.5%")).toBeCloseTo(0.125);
    expect(num("500-")).toBe(-500);
    expect(num("1e3")).toBe(1000);
  });
  it("captures currency and percent flags", () => {
    expect(parseNumberCell("€1.000,50", "eu")).toMatchObject({ value: 1000.5, currency: "EUR" });
    expect(parseNumberCell("15%")).toMatchObject({ percent: true });
  });
  it("reads European formats only under the eu locale", () => {
    expect(num("1.234,50", "eu")).toBe(1234.5);
    expect(num("12,5", "eu")).toBe(12.5);
    expect(num("1.234,50", "us")).toBeNull(); // refuse to guess
    expect(num("1.234.567", "eu")).toBe(1234567);
  });
  it("rejects non-numbers", () => {
    for (const s of ["abc", "12-34", "1,2,3", "", "--", "ORD-100", "3 apples"]) expect(num(s)).toBeNull();
  });
  it("detects the column locale from evidence, not a single ambiguous cell", () => {
    expect(detectDecimalLocale(["1.234,50", "12,5", "999,00"])).toBe("eu");
    expect(detectDecimalLocale(["1,234.50", "12.5", "999.00"])).toBe("us");
    expect(detectDecimalLocale(["1.234", "2.345"])).toBe("us"); // no evidence => default
  });
});

describe("parseDateCell", () => {
  it("parses ISO forms as civil dates and ignores time / zone", () => {
    expect(date("2025-03-01")).toBe("2025-03-01");
    expect(date("2025-03-01T23:59:59Z")).toBe("2025-03-01");
    expect(date("2025-03-01 00:00:00+05:30")).toBe("2025-03-01");
    expect(date("2025/3/1")).toBe("2025-03-01");
  });
  it("respects the column order for numeric dates", () => {
    expect(date("05/03/2025", "mdy")).toBe("2025-05-03");
    expect(date("05/03/2025", "dmy")).toBe("2025-03-05");
    expect(date("13/01/2025", "dmy")).toBe("2025-01-13");
  });
  it("parses month-name forms, year-month and quarters", () => {
    expect(date("28-Feb-2025")).toBe("2025-02-28");
    expect(date("Mar 5, 2025")).toBe("2025-03-05");
    expect(date("March 2025")).toBe("2025-03-01");
    expect(date("2025-03")).toBe("2025-03-01");
    expect(date("2025-Q3")).toBe("2025-07-01");
    expect(date("Q2 2024")).toBe("2024-04-01");
  });
  it("rejects impossible dates", () => {
    for (const s of ["2025-02-30", "31/04/2025", "2025-13-01", "hello", "12345"]) expect(date(s, "dmy")).toBeNull();
  });
  it("detects day-first for the whole column from one unambiguous cell", () => {
    expect(detectDateOrder(["05/03/2025", "13/03/2025"])).toMatchObject({ order: "dmy", ambiguous: false });
    expect(detectDateOrder(["05/13/2025", "05/03/2025"])).toMatchObject({ order: "mdy", ambiguous: false });
    expect(detectDateOrder(["05/03/2025", "06/04/2025"])).toMatchObject({ order: "mdy", ambiguous: true });
  });
});

describe("misc", () => {
  it("null tokens and booleans", () => {
    for (const t of ["", " ", "N/A", "null", "-", "NaN", "#DIV/0!"]) expect(isNullToken(t)).toBe(true);
    expect(isNullToken("0")).toBe(false);
    expect(parseBoolToken("Yes")).toBe(1);
    expect(parseBoolToken("n")).toBe(0);
    expect(parseBoolToken("1")).toBeNull();
  });
});
