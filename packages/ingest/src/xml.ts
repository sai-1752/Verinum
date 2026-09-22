import { XMLParser } from "fast-xml-parser";
import type { RawCell } from "@verinum/core";
import { findRecordArray, recordsToGrid } from "./records";
import { IngestError, type IngestLimits } from "./types";

/** Rejects entity-expansion (billion laughs) and external-entity (XXE) constructs outright. */
export function assertSafeXml(text: string): void {
  if (/<!ENTITY/i.test(text)) throw new IngestError("unsupported_format", "This XML declares custom entities, which aren't supported for safety reasons.", "Remove the DOCTYPE/ENTITY declarations and try again.");
  if (/<!DOCTYPE[^>]*\[/i.test(text)) throw new IngestError("unsupported_format", "This XML has an internal DTD subset, which isn't supported for safety reasons.");
}

export function parseXmlRecords(text: string, limits: IngestLimits): { grid: RawCell[][]; notes: string[] } {
  assertSafeXml(text);
  let root: unknown;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", parseTagValue: false, parseAttributeValue: false,
      trimValues: true, processEntities: true, htmlEntities: false, allowBooleanAttributes: true,
      isArray: () => false,
    });
    root = parser.parse(text.replace(/<!DOCTYPE[^>]*>/gi, ""));
  } catch {
    throw new IngestError("corrupt", "This file isn't valid XML.");
  }
  const found = findRecordArray(root);
  if (!found) {
    // one record: the innermost object
    const top = root && typeof root === "object" ? Object.values(root as Record<string, unknown>)[0] : null;
    if (top && typeof top === "object") {
      const { grid, notes } = recordsToGrid([top], limits);
      return { grid, notes: ["The XML holds a single record."].concat(notes) };
    }
    throw new IngestError("no_tables", "The XML doesn't contain repeating records.", "Expected a list of similar elements, such as <row> or <item>.");
  }
  const { grid, notes } = recordsToGrid(found.items, limits);
  return { grid, notes: [`Rows were read from the repeating element at ${found.path.replace(/^\$\./, "")}.`, ...notes] };
}
