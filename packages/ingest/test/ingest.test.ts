import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFrame, buildProfile } from "@verinum/core";
import { IngestError, escapeCsvCell, ingestFile, ingestInWorker, toCsv, type IngestResult } from "../src/index";
import { enc, makeDocx, makePdf, makeXls, makeXlsx, makeZipBomb, wp, wtbl, addZipEntry, zipSync, strToU8 } from "./helpers/make";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

const here = fileURLToPath(new URL(".", import.meta.url));
const demo = new Uint8Array(readFileSync(`${here}../../../reference/prototype/demo-retail-sales.csv`));
const run = (s: string, name: string) => ingestFile(enc(s), { filename: name });
const codeOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof IngestError ? e.code : `other:${String(e)}`; } };

describe("delimited text", () => {
  it("reads the demo CSV exactly and feeds the same profile as the prototype (quality 74)", async () => {
    const r = await ingestFile(demo, { filename: "demo-retail-sales.csv" });
    expect(r.format).toBe("csv");
    expect(r.tables).toHaveLength(1);
    const t = r.tables[0]!;
    expect(t.columns).toHaveLength(16);
    expect(t.rows).toHaveLength(6764);
    const clean = buildFrame({ name: t.name, columns: t.columns, rows: t.rows });
    const p = buildProfile(clean.frame, clean);
    expect(p.quality.score).toBe(74);
    expect(p.duplicateRows).toBe(14);
  });
  it("detects semicolon, tab and pipe delimiters", async () => {
    for (const [d, fmt] of [[";", "delimited"], ["\t", "tsv"], ["|", "delimited"]] as const) {
      const r = await run(`a${d}b${d}c\n1${d}2${d}3\n4${d}5${d}6\n`, "x.txt");
      expect(r.tables[0]!.columns, d).toEqual(["a", "b", "c"]);
      expect(r.format).toBe(fmt);
      expect(r.tables[0]!.rows).toHaveLength(2);
    }
  });
  it("handles quotes, embedded delimiters and newlines, and a BOM", async () => {
    const r = await run('﻿name,note\n"Smith, J","line1\nline2"\n"say ""hi""",ok\n', "q.csv");
    expect(r.tables[0]!.columns).toEqual(["name", "note"]);
    expect(r.tables[0]!.rows).toEqual([["Smith, J", "line1\nline2"], ['say "hi"', "ok"]]);
  });
  it("falls back to Windows-1252 and UTF-16, and says so", async () => {
    const latin = new Uint8Array([...enc("name,city\n"), ...[0x4a, 0x6f, 0x73, 0xe9], ...enc(",Zürich\n")]); // 'José' with a Latin-1 é, then invalid-UTF-8 ü
    latin[latin.length - 8] = 0xfc;
    const r = await ingestFile(latin, { filename: "l.csv" });
    expect(r.encoding).toBe("windows-1252");
    expect(r.warnings.join(" ")).toMatch(/WINDOWS-1252/);
    expect(r.tables[0]!.rows[0]![0]).toBe("José");
    const u16 = new Uint8Array([0xff, 0xfe, ...[..."a,b\n1,2\n3,4\n"].flatMap((c) => [c.charCodeAt(0), 0])]);
    const r2 = await ingestFile(u16, { filename: "u.csv" });
    expect(r2.encoding).toBe("utf-16le");
    expect(r2.tables[0]!.rows).toHaveLength(2);
  });
  it("skips title/notes rows above the header and reports it", async () => {
    const r = await run("Quarterly report\nGenerated 2026-01-01\n\nDate,Sales,Cost\n2026-01-01,10,5\n2026-01-02,12,6\n", "t.csv");
    expect(r.tables[0]!.columns).toEqual(["Date", "Sales", "Cost"]);
    expect(r.tables[0]!.notes.join(" ")).toMatch(/Skipped \d title or notes row/);
  });
  it("names columns when there is no header", async () => {
    const r = await run("1,2,3\n4,5,6\n7,8,9\n", "n.csv");
    expect(r.tables[0]!.columns).toEqual(["column_1", "column_2", "column_3"]);
    expect(r.tables[0]!.rows).toHaveLength(3);
  });
  it("shortens absurdly long cells and reports it", async () => {
    const r = await ingestFile(enc(`a,b\n${"x".repeat(50_000)},1\n`), { filename: "l.csv", limits: { maxCellChars: 100 } });
    expect((r.tables[0]!.rows[0]![0] as string).length).toBe(100);
    expect(r.tables[0]!.notes.join(" ")).toMatch(/shortened/);
  });
  it("caps rows and columns and says so", async () => {
    const r = await ingestFile(enc(`a,b,c\n${Array.from({ length: 50 }, (_, i) => `${i},1,2`).join("\n")}\n`), { filename: "c.csv", limits: { maxRows: 10, maxColumns: 2 } });
    expect(r.tables[0]!.rows).toHaveLength(10);
    expect(r.tables[0]!.columns).toHaveLength(2);
    expect(r.tables[0]!.truncated).toBe(true);
  });
  it("warns when the extension does not match the contents", async () => {
    const r = await run("a,b\n1,2\n3,4\n", "data.xlsx");
    expect(r.format).toBe("csv");
    expect(r.warnings.join(" ")).toMatch(/extension/);
  });
});

describe("fixed-width and prose", () => {
  it("infers columns from aligned text", async () => {
    const txt = ["Name      City       Sales", "Alice     Boston       120", "Bob       Chicago       95", "Carol     Denver       310", ""].join("\n");
    const r = await run(txt, "report.txt");
    expect(r.format).toBe("fixed_width");
    expect(r.tables[0]!.columns).toEqual(["Name", "City", "Sales"]);
    expect(r.tables[0]!.rows[1]).toEqual(["Bob", "Chicago", "95"]);
  });
  it("turns prose into a structured document with key-value pairs and a text table", async () => {
    const prose = `INVOICE\n\nInvoice Number: INV-2041\nCustomer: Acme Corp\n\nThanks for your business. Payment is due within thirty days of the invoice date.\n\nTotal Due: $1,250.00\n`;
    const r = await run(prose, "invoice.txt");
    expect(r.format).toBe("txt");
    expect(r.tables[0]!.name).toBe("Document text");
    expect(r.tables[0]!.notes.join(" ")).toMatch(/No tables were found/);
    const kv = Object.fromEntries(r.document!.keyValues.map((k) => [k.key, k.value]));
    expect(kv["Invoice Number"]).toBe("INV-2041");
    expect(kv["Total Due"]).toBe("$1,250.00");
    expect(r.document!.blocks[0]).toMatchObject({ type: "heading", text: "INVOICE" });
  });
});

describe("JSON, NDJSON and XML", () => {
  it("reads an array of objects, flattening nested fields", async () => {
    const r = await run(JSON.stringify([{ id: 1, user: { name: "A", tags: ["x", "y"] }, amount: 9.5 }, { id: 2, user: { name: "B" }, amount: 3 }]), "d.json");
    expect(r.format).toBe("json");
    expect(r.tables[0]!.columns).toEqual(["id", "user.name", "user.tags", "amount"]);
    expect(r.tables[0]!.rows[0]).toEqual([1, "A", "x; y", 9.5]);
    expect(r.tables[0]!.rows[1]![2]).toBeNull();
  });
  it("finds the records inside an envelope, and reads NDJSON and keyed objects", async () => {
    const env = await run(JSON.stringify({ meta: { n: 2 }, data: [{ a: 1 }, { a: 2 }] }), "e.json");
    expect(env.tables[0]!.rows).toEqual([[1], [2]]);
    expect(env.tables[0]!.notes.join(" ")).toMatch(/\$\.data/);
    const nd = await run('{"a":1,"b":"x"}\n{"a":2,"b":"y"}\nnot json\n{"a":3,"b":"z"}\n', "e.ndjson");
    expect(nd.format).toBe("ndjson");
    expect(nd.tables[0]!.rows).toHaveLength(3);
    const keyed = await run(JSON.stringify({ u1: { n: "A" }, u2: { n: "B" } }), "k.json");
    expect(keyed.tables[0]!.columns).toEqual(["key", "n"]);
  });
  it("rejects invalid JSON with a helpful message, and ignores prototype-pollution keys", async () => {
    expect(await codeOf(run('{"a": [1,2', "bad.json"))).toBe("corrupt");
    const r = await run('[{"a":1,"__proto__":{"polluted":true},"constructor":{"x":1}}]', "p.json");
    expect(r.tables[0]!.columns).toEqual(["a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("reads repeating XML records including attributes", async () => {
    const xml = `<?xml version="1.0"?><orders><order id="1"><item>Pen</item><qty>3</qty></order><order id="2"><item>Ink</item><qty>5</qty></order></orders>`;
    const r = await run(xml, "o.xml");
    expect(r.format).toBe("xml");
    expect(r.tables[0]!.columns).toEqual(["id", "item", "qty"]);
    expect(r.tables[0]!.rows).toEqual([["1", "Pen", "3"], ["2", "Ink", "5"]]);
  });
  it("rejects XXE and entity-expansion (billion laughs) outright", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r><row><a>&x;</a></row><row><a>2</a></row></r>`;
    expect(await codeOf(run(xxe, "x.xml"))).toBe("unsupported_format");
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`;
    expect(await codeOf(run(laughs, "l.xml"))).toBe("unsupported_format");
  });
});

describe("HTML", () => {
  const page = `<html><head><script>alert(1)</script><style>td{}</style></head><body>
    <h1>Report</h1><p>Intro text.</p>
    <table><caption>Sales by region</caption><thead><tr><th>Region</th><th>Sales</th></tr></thead><tbody><tr><td>East</td><td>10</td></tr><tr><td>West</td><td>20</td></tr></tbody></table>
    <h2>Costs</h2><table><tr><th colspan="2">Cost</th></tr><tr><td>Rent</td><td>5</td></tr><tr><td>Pay</td><td>9</td></tr></table></body></html>`;
  it("extracts every table with captions/headings as names and ignores scripts", async () => {
    const r = await run(page, "r.html");
    expect(r.format).toBe("html");
    expect(r.tables.map((t) => t.name)).toEqual(["Sales by region", "Costs"]);
    expect(r.tables[0]!.columns).toEqual(["Region", "Sales"]);
    expect(r.tables[0]!.rows).toEqual([["East", "10"], ["West", "20"]]);
    expect(JSON.stringify(r)).not.toMatch(/alert\(1\)/);
    expect(r.document!.blocks.some((b) => b.type === "heading" && b.text === "Report")).toBe(true);
  });
});

describe("Excel", () => {
  it("reads sheets, ISO dates (no time-zone shift), formula results; skips hidden sheets", async () => {
    const bytes = await makeXlsx((wb) => {
      const ws = wb.addWorksheet("Sales 2026");
      ws.addRow(["Quarterly report"]);
      ws.addRow([]);
      ws.addRow(["Date", "Region", "Sales", "Cost", "Profit"]);
      ws.addRow([new Date(Date.UTC(2026, 0, 1)), "East", 100, 60, { formula: "C4-D4", result: 40 }]);
      ws.addRow([new Date(Date.UTC(2026, 11, 31, 23, 0, 0)), "West", 120, 70, { formula: "C5-D5", result: 50 }]);
      ws.addRow([new Date(Date.UTC(2026, 5, 15)), "East", 90, 50, { formula: "C6-D6" }]);
      const h = wb.addWorksheet("Hidden"); h.state = "hidden"; h.addRow(["a", "b"]); h.addRow([1, 2]);
      const t = wb.addWorksheet("Targets"); t.addRow(["Region", "Target"]); t.addRow(["East", 5000]); t.addRow(["West", 4000]);
    });
    const r = await ingestFile(bytes, { filename: "s.xlsx" });
    expect(r.format).toBe("xlsx");
    expect(r.tables.map((t) => t.name)).toEqual(["Sales 2026", "Targets"]);
    const s = r.tables[0]!;
    expect(s.columns).toEqual(["Date", "Region", "Sales", "Cost", "Profit"]);
    expect(s.rows[0]).toEqual(["2026-01-01", "East", 100, 60, 40]);
    expect(s.rows[1]![0]).toBe("2026-12-31 23:00:00");
    expect(s.rows[2]![4]).toBeNull(); // formula without a cached result is blank, not evaluated
    expect(s.notes.join(" ")).toMatch(/Skipped 1 title or notes row/);
    expect(r.warnings.join(" ")).toMatch(/1 formula cell had no stored result/);
    expect(r.warnings.join(" ")).toMatch(/"Hidden" is hidden/);
  });
  it("flags macros without running them", async () => {
    const base = await makeXlsx((wb) => { wb.addWorksheet("S").addRows([["a", "b"], [1, 2], [3, 4]]); });
    const withMacro = addZipEntry(base, "xl/vbaProject.bin", enc("not really a macro"));
    const r = await ingestFile(withMacro, { filename: "m.xlsm" });
    expect(r.warnings.join(" ")).toMatch(/macros/);
    expect(r.tables[0]!.rows).toHaveLength(2);
  });
  it("reads legacy .xls in the sandbox, including dates and hidden sheets", async () => {
    const bytes = makeXls((wb) => {
      const ws = XLSX.utils.aoa_to_sheet([["Date", "Sales"], [46023, 10], [46024, 20], [46025, 30]]);
      for (const a of ["A2", "A3", "A4"]) ws[a]!.z = "yyyy-mm-dd";
      XLSX.utils.book_append_sheet(wb, ws, "Data");
      const h = XLSX.utils.aoa_to_sheet([["x", "y"], [1, 2]]);
      XLSX.utils.book_append_sheet(wb, h, "Secret");
      wb.Workbook = { Sheets: [{ name: "Data", Hidden: 0 }, { name: "Secret", Hidden: 1 }] } as never;
    });
    const r = await ingestFile(bytes, { filename: "legacy.xls" });
    expect(r.format).toBe("xls");
    expect(r.tables.map((t) => t.name)).toEqual(["Data"]);
    expect(r.tables[0]!.rows[0]).toEqual(["2026-01-01", 10]);
    expect(r.warnings.join(" ")).toMatch(/"Secret" is hidden/);
  });
  it("reports a damaged workbook plainly", async () => {
    const good = await makeXlsx((wb) => { wb.addWorksheet("S").addRows([["a"], [1]]); });
    expect(await codeOf(ingestFile(good.slice(0, Math.floor(good.length / 2)), { filename: "b.xlsx" }))).toMatch(/corrupt|unsupported_format/);
  });
});

describe("Word and PDF", () => {
  it("reads headings, paragraphs and tables from DOCX in order", async () => {
    const doc = makeDocx(wp("Sales review", "Heading1") + wp("Prepared by: Dana Lee") + wtbl([["Region", "Sales"], ["East", "10"], ["West", "20"]]) + wp("Closing remarks."));
    const r = await ingestFile(doc, { filename: "r.docx" });
    expect(r.format).toBe("docx");
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.columns).toEqual(["Region", "Sales"]);
    expect(r.tables[0]!.rows).toEqual([["East", "10"], ["West", "20"]]);
    expect(r.document!.title).toBe("Sales review");
    expect(r.document!.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "table", "paragraph"]);
    expect(r.document!.keyValues).toContainEqual({ key: "Prepared by", value: "Dana Lee" });
  });
  it("finds a table in a PDF by column alignment, and keeps prose as paragraphs", async () => {
    const rows = [["Product", "Units", "Revenue"], ["Widget", "10", "1,200"], ["Gadget", "4", "800"], ["Doohickey", "7", "560"]];
    const items = [{ x: 72, y: 720, text: "Annual summary", size: 16 }, ...rows.flatMap((r, i) => r.map((c, j) => ({ x: [72, 250, 400][j]!, y: 680 - i * 16, text: c }))), { x: 72, y: 560, text: "All figures are in thousands." }];
    const r = await ingestFile(makePdf([items]), { filename: "s.pdf" });
    expect(r.format).toBe("pdf");
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.columns).toEqual(["Product", "Units", "Revenue"]);
    expect(r.tables[0]!.rows[0]).toEqual(["Widget", "10", "1,200"]);
    expect(r.tables[0]!.notes.join(" ")).toMatch(/page 1/);
    expect(r.document!.pages).toBe(1);
    expect(r.document!.blocks.some((b) => b.type === "paragraph" && /thousands/.test(b.text))).toBe(true);
  });
  it("says so when a PDF has no text layer", async () => {
    expect(await codeOf(ingestFile(makePdf([[]]), { filename: "scan.pdf" }))).toBe("no_tables");
  });
});

describe("hostile and broken files", () => {
  it("stops a zip bomb by counting inflated bytes, not trusting the header", async () => {
    const bomb = makeZipBomb("xl/worksheets/sheet1.xml", 64 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(200_000);
    const t0 = Date.now();
    expect(await codeOf(ingestFile(bomb, { filename: "b.xlsx", limits: { maxUncompressedBytes: 8 * 1024 * 1024 } }))).toBe("limit_exceeded");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("rejects too many archive entries and traversal names", async () => {
    const many = zipSync(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.txt`, strToU8("x")])));
    expect(await codeOf(ingestFile(many, { filename: "m.zip", limits: { maxZipEntries: 50 } }))).toBe("limit_exceeded");
    const trav = zipSync({ "../../etc/passwd": strToU8("x"), "word/document.xml": strToU8("<x/>") });
    expect(await codeOf(ingestFile(trav, { filename: "t.docx" }))).toBe("limit_exceeded");
  });
  it("rejects oversized, empty, binary and unsupported files with clear codes", async () => {
    expect(await codeOf(ingestFile(new Uint8Array(2000), { filename: "big.csv", limits: { maxBytes: 1000 } }))).toBe("too_large");
    expect(await codeOf(ingestFile(new Uint8Array(0), { filename: "e.csv" }))).toBe("empty");
    const junk = new Uint8Array(4096).map((_, i) => (i * 7919 + 13) % 256);
    expect(await codeOf(ingestFile(junk, { filename: "x.csv" }))).toBe("unsupported_format");
    expect(await codeOf(ingestFile(zipSync({ "a.txt": strToU8("hello") }), { filename: "a.zip" }))).toBe("unsupported_format");
  });
  it("trusts contents over the extension (a PDF named .csv is read as PDF)", async () => {
    const pdf = makePdf([[{ x: 72, y: 700, text: "Hello there" }]]);
    const r = await ingestFile(pdf, { filename: "sneaky.csv" });
    expect(r.format).toBe("pdf");
  });
  it("hides internals: errors carry only user-safe messages", async () => {
    try { await ingestFile(enc('{"a": ['), { filename: "x.json" }); } catch (e) {
      expect((e as IngestError).message).not.toMatch(/at |\/home|node_modules|Unexpected/);
    }
  });
});

describe("worker runner", () => {
  it("runs ingestion off-thread and returns the same result", async () => {
    const r: IngestResult = await ingestInWorker(demo, { filename: "demo.csv" });
    expect(r.tables[0]!.rows).toHaveLength(6764);
  });
  it("propagates typed errors from the worker", async () => {
    expect(await codeOf(ingestInWorker(enc('{"a": ['), { filename: "x.json" }))).toBe("corrupt");
    expect(await codeOf(ingestInWorker(new Uint8Array(0), { filename: "x.csv" }))).toBe("empty");
  });
});

describe("exports", () => {
  it("neutralises formula injection in text cells but leaves real numbers alone", () => {
    expect(escapeCsvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(escapeCsvCell("+1+1")).toBe("'+1+1");
    expect(escapeCsvCell("-5")).toBe("-5");
    expect(escapeCsvCell(-5)).toBe("-5");
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCsvCell(null)).toBe("");
    const csv = toCsv({ columns: ["n", "v"], rows: [["=cmd|' /C calc'!A0", 1]] });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(`'=cmd|' /C calc'!A0`);
  });
});

void ExcelJS;
