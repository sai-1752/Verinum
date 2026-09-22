import { describe, expect, it } from "vitest";
import { extractNumericClaims } from "../src/grounding/numbers";
import { FactLedger } from "../src/grounding/ledger";
import { SentenceGate, sanitizeAnswer } from "../src/grounding/gate";
import { FactSet } from "../src/facts";

const vals = (t: string, labels: string[] = []) => extractNumericClaims(t, { labels }).map((c) => [c.raw, c.value]);

describe("numeric claim extraction", () => {
  it("does not treat ISO dates, month keys, quarter keys or date ranges as numbers", () => {
    for (const t of ["data runs 2025-02-28 to 2026-08-30 fine", "Between 2026-08 and 2026-07", "Q3-2026 and 2026-Q1", "range 2025-02-28–2026-08-30"]) {
      expect(vals(t), t).toEqual([]);
    }
  });

  it("parses plain, grouped, decimal and negative numbers", () => {
    expect(vals("We sold 1,234 units, 12.5 kg and -7 items.")).toEqual([["1,234", 1234], ["12.5", 12.5], ["-7", 7]]);
    expect(extractNumericClaims("down -7 items")[0]!.negative).toBe(true);
  });

  it("applies K/M/B suffixes with rounding-aware tolerance", () => {
    const [c] = extractNumericClaims("Sales were $3.2M this year");
    expect(c).toMatchObject({ value: 3_200_000, kind: "currency", symbol: "$", decimals: 1 });
    expect(c!.tolerance).toBeCloseTo(50_000);
    expect(extractNumericClaims("about 18.7K")[0]).toMatchObject({ value: 18_700, hedged: true });
    expect(extractNumericClaims("2 billion")[0]!.value).toBe(2e9);
  });

  it("marks percentages and ratios", () => {
    expect(extractNumericClaims("margin of 31.2%")[0]).toMatchObject({ kind: "percent", value: 31.2, decimals: 1 });
    expect(extractNumericClaims("1.7× an even split")[0]).toMatchObject({ kind: "ratio", value: 1.7 });
    expect(extractNumericClaims("12 percent")[0]).toMatchObject({ kind: "percent", value: 12 });
  });

  it("ignores dates, periods and years", () => {
    expect(vals("From 2025-03-01 to 2026-08-30, in 2026-08, 2026-Q3 and Q4 2025 (FY2026) during 2026.")).toEqual([]);
    expect(vals("On March 3, 2026 and 3 March 2026 and Mar 2025.")).toEqual([]);
    expect(vals("At 10:30 am we met")).toEqual([]);
  });

  it("does not treat a year-like number with a unit as a year", () => {
    expect(vals("about 2000 units")).toEqual([["2000", 2000]]);
    expect(vals("2,026 rows")).toEqual([["2,026", 2026]]);
  });

  it("ignores identifiers, ordinals, list numbering and hashes", () => {
    expect(vals("Order ORD-100123 for SKU123 in Q4 was the 3rd largest, #2 overall, H2 results")).toEqual([]);
    expect(vals("1. First point\n2) Second point\n(3) third")).toEqual([]);
  });

  it("ignores digits inside known labels", () => {
    expect(vals("Product 12 leads and Zone 3 lags", ["Product 12", "Zone 3"])).toEqual([]);
    expect(vals("Product 12 sold 40 units", ["Product 12"])).toEqual([["40", 40]]);
  });

  it("ignores code, urls and emails", () => {
    expect(vals("Use `top_n(5)` at https://example.com/a/123 or mail a1@b2.com")).toEqual([]);
  });

  it("treats hyphens between numbers as ranges, not minus", () => {
    const c = extractNumericClaims("between 3-5 rows");
    expect(c.map((x) => [x.value, x.negative])).toEqual([[3, false], [5, false]]);
  });

  it("finds spelled-out numbers used as counts, but not pronoun 'one' or 'two of the'", () => {
    expect(vals("The three regions and five channels")).toEqual([["three", 3], ["five", 5]]);
    expect(vals("one of the regions; two of the products")).toEqual([]);
  });
});

function ledgerWith(build: (fs: FactSet) => void, fmt = {}) {
  const fs = new FactSet(fmt);
  build(fs);
  const l = new FactLedger();
  l.addFacts("t1", fs.facts);
  return l;
}

describe("ledger verification", () => {
  const l = ledgerWith((fs) => {
    fs.num("Total sales", 3225540.86, "currency");
    fs.num("Share", 15.702, "percent");
    fs.num("Rows", 6764, "count");
    fs.num("Change", -7.7, "percent", { signed: true });
    fs.num("Multiple", 1.66, "ratio", { decimals: 1 });
  });

  it("accepts numbers that round to a fact at the precision shown", () => {
    for (const t of ["3.23M", "3.2M", "about 3 million", "15.7%", "16%", "15.70%", "6,764 rows", "1.7× an even split"]) {
      expect(l.validateText(`Value is ${t}.`).ok, t).toBe(true);
    }
  });

  it("rejects numbers a fact cannot support", () => {
    for (const t of ["3.3M", "3.5M", "15.9%", "6,700 rows", "1.9×", "42%"]) {
      expect(l.validateText(`Value is ${t}.`).ok, t).toBe(false);
    }
  });

  it("does not let a percent claim match a non-percent fact or vice versa", () => {
    expect(l.validateText("It was 6,764%.").ok).toBe(false);
    expect(l.validateText("It was 15.7 rows.").ok).toBe(false);
  });

  it("accepts a fraction for a percent fact", () => {
    expect(l.validateText("The share is 0.157.").ok).toBe(true);
  });

  it("rejects a currency symbol the data does not carry", () => {
    const r = l.validateText("Sales were $3.2M.");
    expect(r.ok).toBe(false);
    expect(r.unverified[0]!.reason).toBe("currency_symbol");
    const eur = ledgerWith((fs) => fs.num("Total", 3225540.86, "currency"), { currency: "EUR" });
    expect(eur.validateText("Sales were €3.2M.").ok).toBe(true);
    expect(eur.validateText("Sales were $3.2M.").ok).toBe(false);
  });

  it("catches an inverted direction against a signed fact", () => {
    expect(l.validateText("Sales rose 7.7% last month.").ok).toBe(false);
    expect(l.validateText("Sales fell 7.7% last month.").ok).toBe(true);
    expect(l.validateText("Sales fell -7.7% last month.").ok).toBe(true);
    expect(l.validateText("Costs rose while sales fell 7.7% last month.").ok).toBe(true); // mixed cues → not judged
  });

  it("allows numbers the user supplied or that are tool parameters", () => {
    const x = new FactLedger();
    x.addUserText("Show orders above 500 for the top 5 products");
    expect(x.validateText("Orders above 500 …").ok).toBe(true);
    x.addParams("t9", { limit: 10, filters: [{ value: 250 }] });
    expect(x.validateText("The top 10 orders over 250.").ok).toBe(true);
    expect(x.validateText("Top 11.").ok).toBe(false);
  });

  it("uses dictionary labels to avoid false alarms", () => {
    const x = new FactLedger();
    x.addLabels(["Product 12"]);
    expect(x.validateText("Product 12 leads.").ok).toBe(true);
  });
});

describe("SentenceGate", () => {
  const ledger = () => ledgerWith((fs) => { fs.num("Sales", 3225540.86, "currency"); fs.num("Share", 15.7, "percent"); });

  it("passes verified sentences and drops the ones with untraceable numbers", () => {
    const { text, stats } = sanitizeAnswer("Total sales are 3.23M. Growth was 42% last year. Aura Watch holds 15.7% of sales.", ledger());
    expect(text).toBe("Total sales are 3.23M. Aura Watch holds 15.7% of sales.");
    expect(stats.dropped).toBe(1);
    expect(stats.droppedSentences[0]!.unverified).toEqual(["42%"]);
  });

  it("does not split sentences inside decimals or abbreviations", () => {
    const { text, stats } = sanitizeAnswer("Sales are 3.23M, e.g. Aura Watch at 15.7% of the total. Nothing else.", ledger());
    expect(stats.dropped).toBe(0);
    expect(text).toContain("15.7%");
  });

  it("streams: never emits a partial sentence, and drops across chunk boundaries", () => {
    const gate = new SentenceGate(ledger());
    const emitted: string[] = [];
    const chunks = ["Total sales are 3", ".23M. Growth was 4", "2% last year. Done", "."];
    for (const c of chunks) emitted.push(gate.push(c));
    emitted.push(gate.flush());
    const all = emitted.join("");
    expect(all).toBe("Total sales are 3.23M. Done.");
    // nothing containing "42" was ever emitted, at any point
    expect(emitted.some((e) => e.includes("42"))).toBe(false);
    // the first chunk emitted nothing (its sentence was incomplete)
    expect(emitted[0]).toBe("");
  });

  it("verifies each markdown table row and list item independently", () => {
    const md = "| Product | Sales |\n|---|---|\n| A | 3.23M |\n| B | 99M |\n\n- Share is 15.7%\n- Bogus 77%\n";
    const { text } = sanitizeAnswer(md, ledger());
    expect(text).toContain("| A | 3.23M |");
    expect(text).not.toContain("99M");
    expect(text).toContain("Share is 15.7%");
    expect(text).not.toContain("77%");
  });

  it("reports the drop ratio so callers can fall back to the deterministic answer", () => {
    const r = sanitizeAnswer("Up 50%. Up 60%. Sales are 3.23M.", ledger());
    expect(r.dropRatio).toBeCloseTo(2 / 3);
  });

  it("leaves numberless text untouched, including numbered lists", () => {
    const src = "Here is what I found.\n\n1. The leader is Aura Watch.\n2. It is followed by Nimbus Ring.";
    const r = sanitizeAnswer(src, ledger());
    expect(r.text).toBe(src);
  });
});

describe("regression: numeric display strings in tool data are never exempt labels", () => {
  const result = (facts: never[] = []) => ({
    facts, data: { rows: [{ name: "Aura Watch", value: "506.5K", share: "15.7%" }], note: "Q4 ORD-1001" },
    provenance: { tool: "t", params: {}, filters: [], rowsConsidered: 1, columns: [], dataset: "d", computedAt: "x" } as never,
  });
  it("a number that only appears as a formatted string in result data (not as a fact) is unverified", () => {
    const l = new FactLedger();
    l.addResult("c1", result());
    expect(l.validateText("Aura Watch made 506.5K.").ok).toBe(false);
    expect(l.validateText("Its share is 15.7%.").ok).toBe(false);
  });
  it("real labels containing digits are still ignored", () => {
    const l = new FactLedger();
    l.addResult("c1", result());
    expect(l.validateText("Order ORD-1001 was in Q4.").ok).toBe(true);
  });
});
