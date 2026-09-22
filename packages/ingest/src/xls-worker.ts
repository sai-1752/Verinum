/**
 * Legacy .xls reader, run in an isolated worker thread. SheetJS 0.18.5 (the last release on npm) has
 * known prototype-pollution and ReDoS advisories, so it never runs in the API process: this worker
 * has capped memory, an empty environment, receives only the file bytes and can only return plain
 * cell values. The parent terminates it on timeout.
 */
import { parentPort, workerData } from "node:worker_threads";
import XLSX from "xlsx";

interface In { bytes: Uint8Array; maxRows: number; maxColumns: number; maxSheets: number }
export interface XlsSheet { name: string; hidden: boolean; grid: (string | number | boolean | null)[][] }
export type XlsOut = { ok: true; sheets: XlsSheet[]; truncated: boolean } | { ok: false; code: "encrypted" | "corrupt" | "unsupported"; message: string };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function serialToString(serial: number, date1904: boolean): string {
  const days = serial + (date1904 ? 1462 : 0);
  // Excel's 1900 leap-year bug: serials ≥ 61 are one day ahead of the real calendar
  const unix = (days < 61 ? days - 25568 : days - 25569) * 86400000;
  const d = new Date(Math.round(unix / 1000) * 1000);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  return h || m || s ? `${date} ${pad(h)}:${pad(m)}:${pad(s)}` : date;
}

function run(input: In): XlsOut {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(input.bytes, { type: "array", cellFormula: false, cellHTML: false, cellStyles: false, cellNF: true, cellText: false, cellDates: false, sheetStubs: false, sheetRows: input.maxRows + 1, bookVBA: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/password|encrypt/i.test(msg)) return { ok: false, code: "encrypted", message: "This workbook is password-protected." };
    return { ok: false, code: "corrupt", message: "This Excel file is damaged or isn't a valid workbook." };
  }
  const date1904 = !!(wb.Workbook as { WBProps?: { date1904?: boolean } } | undefined)?.WBProps?.date1904;
  const hiddenByName = new Map<string, boolean>();
  for (const s of ((wb.Workbook as { Sheets?: { name: string; Hidden?: number }[] } | undefined)?.Sheets ?? [])) hiddenByName.set(s.name, (s.Hidden ?? 0) > 0);
  const sheets: XlsSheet[] = [];
  let truncated = false;
  for (const name of wb.SheetNames.slice(0, input.maxSheets)) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const rows = Math.min(range.e.r - range.s.r + 1, input.maxRows + 1);
    const cols = Math.min(range.e.c - range.s.c + 1, input.maxColumns);
    if (range.e.c - range.s.c + 1 > input.maxColumns || range.e.r - range.s.r + 1 > input.maxRows + 1) truncated = true;
    const grid: XlsSheet["grid"] = [];
    for (let r = 0; r < rows; r++) {
      const row: XlsSheet["grid"][number] = [];
      for (let c = 0; c < cols; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })] as XLSX.CellObject | undefined;
        if (!cell || cell.v === undefined || cell.v === null) { row.push(null); continue; }
        if (cell.t === "n" && typeof cell.v === "number" && cell.z && XLSX.SSF.is_date(String(cell.z))) row.push(serialToString(cell.v, date1904));
        else if (cell.t === "e") row.push(null);
        else if (cell.t === "n" || cell.t === "b") row.push(cell.v as number | boolean);
        else row.push(String(cell.v));
      }
      grid.push(row);
    }
    sheets.push({ name, hidden: hiddenByName.get(name) ?? false, grid });
  }
  return { ok: true, sheets, truncated };
}

if (parentPort) {
  const out = run(workerData as In);
  parentPort.postMessage(out);
}
export { run as _runForTests };
