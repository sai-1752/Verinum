/**
 * User-approved cleaning actions. Automatic cleaning (clean.ts) only makes lossless, explainable
 * changes; anything that removes rows or merges labels is offered as a suggestion and applied here
 * only when the user chooses it. Each action returns the new frame plus a plain-language log entry.
 */
import { Frame, NULL_CODE, type Column, type StringColumn } from "./frame";
import { duplicateMaskOf, type Transformation } from "./clean";

export interface ActionResult { frame: Frame; log: Transformation[] }

export function removeDuplicateRows(frame: Frame): ActionResult {
  const { mask, count } = duplicateMaskOf(frame);
  if (!count) return { frame, log: [] };
  const keep = new Uint32Array(frame.rowCount - count);
  let k = 0;
  for (let i = 0; i < frame.rowCount; i++) if (!mask[i]) keep[k++] = i;
  return {
    frame: frame.take(keep),
    log: [{
      id: "action-remove-duplicates", kind: "remove_duplicates", affected: count, severity: "notice",
      detail: `Removed ${count.toLocaleString("en-US")} row${count === 1 ? "" : "s"} that exactly repeated an earlier row (every column identical). The first occurrence of each was kept.`,
    }],
  };
}

const labelKey = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** Merges labels that differ only by case, spacing or Unicode form ("north" / "North " / "NORTH"). */
export function normalizeLabels(frame: Frame, only?: string[]): ActionResult {
  const log: Transformation[] = [];
  const columns: Column[] = frame.columns.map((c): Column => {
    if (c.kind !== "string" || (only && !only.includes(c.name))) return c;
    const counts = new Array<number>(c.dict.length).fill(0);
    for (let i = 0; i < c.codes.length; i++) { const code = c.codes[i]!; if (code !== NULL_CODE) counts[code]!++; }
    const groups = new Map<string, number[]>();
    c.dict.forEach((label, code) => {
      const k = labelKey(label);
      const g = groups.get(k);
      if (g) g.push(code); else groups.set(k, [code]);
    });
    if (![...groups.values()].some((g) => g.length > 1)) return c;

    const newDict: string[] = [];
    const remap = new Array<number>(c.dict.length);
    let mergedCells = 0;
    const examples: string[] = [];
    for (const codes of groups.values()) {
      // the most frequent spelling wins; ties keep the earliest
      let best = codes[0]!;
      for (const code of codes) if (counts[code]! > counts[best]!) best = code;
      const target = newDict.length;
      newDict.push(c.dict[best]!.replace(/\s+/g, " ").trim());
      for (const code of codes) {
        remap[code] = target;
        if (code !== best) {
          mergedCells += counts[code]!;
          if (examples.length < 4) examples.push(`"${c.dict[code]}" → "${c.dict[best]}"`);
        }
      }
    }
    const out = new Uint32Array(c.codes.length);
    for (let i = 0; i < out.length; i++) { const code = c.codes[i]!; out[i] = code === NULL_CODE ? NULL_CODE : remap[code]!; }
    log.push({
      id: `action-normalize-${c.name}`, kind: "normalize_labels", column: c.name, affected: mergedCells, severity: "notice",
      detail: `Merged spelling variants in "${c.name}" (${c.dict.length} → ${newDict.length} distinct labels). Only differences in capitalisation and spacing were merged.`,
      examples,
    });
    const next: StringColumn = { kind: "string", name: c.name, codes: out, dict: newDict };
    return next;
  });
  return { frame: log.length ? new Frame(frame.rowCount, columns) : frame, log };
}

export function dropColumns(frame: Frame, names: string[]): ActionResult {
  const drop = new Set(names.filter((n) => frame.has(n)));
  if (!drop.size) return { frame, log: [] };
  return {
    frame: new Frame(frame.rowCount, frame.columns.filter((c) => !drop.has(c.name))),
    log: [{ id: "action-drop-columns", kind: "drop_columns", affected: drop.size, severity: "info", detail: `Excluded ${drop.size} column${drop.size === 1 ? "" : "s"} from the analysis: ${[...drop].map((n) => `"${n}"`).join(", ")}.` }],
  };
}
