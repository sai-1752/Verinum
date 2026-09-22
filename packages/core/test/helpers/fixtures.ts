import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { buildFrame, type RawTable } from "../../src/clean";

const here = fileURLToPath(new URL(".", import.meta.url));
export const DEMO_CSV = `${here}../../../../reference/prototype/demo-retail-sales.csv`;

export function csvToRaw(text: string, name = "test"): RawTable {
  const rows = parse(text, { skip_empty_lines: false, relax_column_count: true }) as string[][];
  return { name, columns: rows[0]!, rows: rows.slice(1) };
}

let cachedDemo: RawTable | null = null;
export function demoRaw(): RawTable {
  if (!cachedDemo) cachedDemo = csvToRaw(readFileSync(DEMO_CSV, "utf8"), "demo");
  return cachedDemo;
}
export const demoClean = () => buildFrame(demoRaw());
