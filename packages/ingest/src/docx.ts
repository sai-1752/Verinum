/** .docx extraction: paragraphs, headings and tables in reading order. Macros/embedded objects are never read. */
import { XMLParser } from "fast-xml-parser";
import type { RawCell } from "@verinum/core";
import { readZip } from "./safe-zip";
import { assertSafeXml } from "./xml";
import { IngestError, type DocBlock, type IngestLimits } from "./types";

type Node = Record<string, unknown>;

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function runText(p: Node): string {
  let out = "";
  const walk = (n: unknown) => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const o = n as Node;
    for (const [k, v] of Object.entries(o)) {
      if (k === "w:t") out += arr(v as unknown[]).map((t) => (typeof t === "object" && t !== null ? String((t as Node)["#text"] ?? "") : String(t))).join("");
      else if (k === "w:tab") out += "\t";
      else if (k === "w:br") out += "\n";
      else if (!k.startsWith("@")) walk(v);
    }
  };
  walk(p);
  return out;
}

function headingLevel(p: Node): number | null {
  const style = ((p["w:pPr"] as Node | undefined)?.["w:pStyle"] as Node | undefined)?.["@w:val"];
  if (typeof style !== "string") return null;
  const m = /^(?:Heading|heading|Title)(\d)?$/.exec(style);
  return m ? Number(m[1] ?? 1) : null;
}

export function extractDocx(bytes: Uint8Array, limits: IngestLimits): { blocks: DocBlock[]; tables: RawCell[][][]; warnings: string[] } {
  const { entries } = readZip(bytes, limits, (n) => n === "word/document.xml");
  const xml = entries.get("word/document.xml");
  if (!xml) throw new IngestError("corrupt", "This Word file has no readable document body.");
  const text = new TextDecoder().decode(xml);
  assertSafeXml(text);
  const blocks: DocBlock[] = [];
  const tables: RawCell[][][] = [];
  const warnings: string[] = [];

  // preserveOrder keeps paragraphs and tables in reading order (the default grouping by tag name would lose it)
  let ordered: Node[];
  try {
    ordered = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: false, parseTagValue: false, trimValues: false, preserveOrder: true }).parse(text) as Node[];
  } catch {
    throw new IngestError("corrupt", "This Word file is damaged.");
  }
  const bodyOrdered = findChild(findChild(ordered, "w:document") as Node[] | undefined, "w:body") as Node[] | undefined;
  if (!bodyOrdered) return { blocks, tables, warnings: ["The document body was empty."] };

  for (const item of bodyOrdered) {
    if ("w:p" in item) {
      const p = simplify(item["w:p"] as Node[]);
      const t = paraText(item["w:p"] as Node[]).replace(/[ \t]+/g, " ").trim();
      if (!t) continue;
      const level = headingLevel(p);
      blocks.push(level ? { type: "heading", level, text: t } : { type: "paragraph", text: t });
    } else if ("w:tbl" in item) {
      const rows: RawCell[][] = [];
      for (const tr of (item["w:tbl"] as Node[]).filter((x) => "w:tr" in x)) {
        const row: RawCell[] = [];
        for (const tc of (tr["w:tr"] as Node[]).filter((x) => "w:tc" in x)) {
          const parts = (tc["w:tc"] as Node[]).filter((x) => "w:p" in x).map((p) => paraText(p["w:p"] as Node[]).trim()).filter(Boolean);
          row.push(parts.join(" "));
          // horizontal merge: pad with blanks
          const span = Number(((simplify(tc["w:tc"] as Node[])["w:tcPr"] as Node | undefined)?.["w:gridSpan"] as Node | undefined)?.["@w:val"] ?? 1);
          for (let k = 1; k < Math.min(span, 50); k++) row.push("");
        }
        if (row.some((c) => c !== "")) rows.push(row);
      }
      if (rows.length >= 2) { tables.push(rows); blocks.push({ type: "table", tableIndex: tables.length - 1 }); }
    }
  }
  return { blocks, tables, warnings };
}

function findChild(list: Node[] | undefined, name: string): unknown {
  return list?.find((x) => name in x)?.[name];
}

function simplify(children: Node[]): Node {
  const out: Node = {};
  for (const c of children) {
    const attrs = c[":@"] as Node | undefined;
    for (const [k, v] of Object.entries(c)) {
      if (k === ":@") continue;
      const inner = Array.isArray(v) ? simplify(v as Node[]) : v;
      out[k] = attrs ? { ...(typeof inner === "object" && inner ? (inner as Node) : {}), ...attrs } : inner;
    }
  }
  return out;
}

/** Text of a paragraph given its preserveOrder children. */
function paraText(children: Node[]): string {
  let out = "";
  for (const c of children) {
    for (const [k, v] of Object.entries(c)) {
      if (k === "w:r" || k === "w:hyperlink" || k === "w:smartTag" || k === "w:sdt" || k === "w:sdtContent" || k === "w:ins") out += paraText(v as Node[]);
      else if (k === "w:t") out += (v as Node[]).map((t) => String(t["#text"] ?? "")).join("");
      else if (k === "w:tab") out += "\t";
      else if (k === "w:br") out += "\n";
    }
  }
  return out;
}
export { runText as _runTextForTests };
