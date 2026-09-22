import ExcelJS from "exceljs";
import { deflateSync, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";

export const enc = (s: string) => new TextEncoder().encode(s);

export async function makeXlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export function makeXls(build: (wb: XLSX.WorkBook) => void): Uint8Array {
  const wb = XLSX.utils.book_new();
  build(wb);
  return new Uint8Array(XLSX.write(wb, { bookType: "biff8", type: "buffer" }) as Buffer);
}

export function makeDocx(bodyXml: string): Uint8Array {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
    "word/document.xml": strToU8(doc),
  });
}
export const wp = (t: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
export const wtbl = (rows: string[][]) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${wp(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;

/** A minimal single-page PDF whose text items are placed at exact coordinates. */
export function makePdf(items: { x: number; y: number; text: string; size?: number }[][]): Uint8Array {
  const objs: string[] = [];
  const pageIds: number[] = [];
  const content = items.map((page) => page.map((i) => `BT /F1 ${i.size ?? 10} Tf 1 0 0 1 ${i.x} ${i.y} Tm (${i.text.replace(/([()\\])/g, "\\$1")}) Tj ET`).join("\n"));
  // 1 catalog, 2 pages, 3 font, then per page: page object + content stream
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let n = 4;
  for (const c of content) {
    const pageId = n++, contentId = n++;
    pageIds.push(pageId);
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[contentId] = `<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return enc(out);
}

/** A ZIP whose single entry inflates to `size` bytes of zeros (a classic zip bomb, at small scale). */
export function makeZipBomb(name: string, size: number): Uint8Array {
  const chunk = new Uint8Array(1024 * 1024);
  const parts: Uint8Array[] = [];
  // build in pieces so the test itself stays cheap: deflate one MB, then repeat compressed blocks via a stored ZIP of a big buffer
  for (let i = 0; i < Math.ceil(size / chunk.length); i++) parts.push(chunk);
  const big = new Uint8Array(size);
  return zipSync({ [name]: [big, { level: 9 }] }, { level: 9 });
}

export function addZipEntry(zip: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const files = unzipSync(zip);
  return zipSync({ ...files, [name]: data });
}

export { deflateSync, zipSync, strToU8 };
