/**
 * Typed columnar frame. Parsed once at ingestion; every later operation is an array scan.
 *
 *  - number  → Float64Array, NaN = null
 *  - date    → Int32Array of civil days (see time.ts), NULL_DATE = null
 *  - string  → dictionary encoded: Uint32Array codes + string[] dictionary, NULL_CODE = null
 *  - boolean → Uint8Array 0/1, NULL_BOOL = null
 */
import type { DateOrder } from "./values";

export const NULL_DATE = -2147483648;
export const NULL_CODE = 0xffffffff;
export const NULL_BOOL = 255;

export interface NumberMeta {
  currency?: string;
  percent?: boolean;
  decimalLocale?: "us" | "eu";
}
export interface DateMeta {
  order?: DateOrder;
  orderAmbiguous?: boolean;
  hasTime?: boolean;
}

export interface NumberColumn { kind: "number"; name: string; values: Float64Array; meta: NumberMeta }
export interface DateColumn { kind: "date"; name: string; values: Int32Array; meta: DateMeta }
export interface StringColumn { kind: "string"; name: string; codes: Uint32Array; dict: string[] }
export interface BooleanColumn { kind: "boolean"; name: string; values: Uint8Array }
export type Column = NumberColumn | DateColumn | StringColumn | BooleanColumn;
export type ColumnKind = Column["kind"];

/** A subset of rows: sorted-or-not row indices, or null meaning "every row". */
export type RowSet = Uint32Array | null;

export class Frame {
  readonly rowCount: number;
  readonly columns: Column[];
  private readonly byName = new Map<string, Column>();

  constructor(rowCount: number, columns: Column[]) {
    this.rowCount = rowCount;
    this.columns = columns;
    for (const c of columns) this.byName.set(c.name, c);
  }

  has(name: string): boolean { return this.byName.has(name); }
  get(name: string): Column | undefined { return this.byName.get(name); }
  names(): string[] { return this.columns.map((c) => c.name); }

  require(name: string): Column {
    const c = this.byName.get(name);
    if (!c) throw new FrameError(`Column "${name}" does not exist.`);
    return c;
  }
  number(name: string): NumberColumn {
    const c = this.require(name);
    if (c.kind !== "number") throw new FrameError(`Column "${name}" is ${c.kind}, not number.`);
    return c;
  }
  date(name: string): DateColumn {
    const c = this.require(name);
    if (c.kind !== "date") throw new FrameError(`Column "${name}" is ${c.kind}, not date.`);
    return c;
  }
  string(name: string): StringColumn {
    const c = this.require(name);
    if (c.kind !== "string") throw new FrameError(`Column "${name}" is ${c.kind}, not string.`);
    return c;
  }

  /** A new frame containing only the given rows (copying data). */
  take(rows: Uint32Array): Frame {
    const n = rows.length;
    const cols: Column[] = this.columns.map((c): Column => {
      switch (c.kind) {
        case "number": { const v = new Float64Array(n); for (let k = 0; k < n; k++) v[k] = c.values[rows[k]!]!; return { ...c, values: v }; }
        case "date": { const v = new Int32Array(n); for (let k = 0; k < n; k++) v[k] = c.values[rows[k]!]!; return { ...c, values: v }; }
        case "boolean": { const v = new Uint8Array(n); for (let k = 0; k < n; k++) v[k] = c.values[rows[k]!]!; return { ...c, values: v }; }
        case "string": { const v = new Uint32Array(n); for (let k = 0; k < n; k++) v[k] = c.codes[rows[k]!]!; return { ...c, codes: v }; }
      }
    });
    return new Frame(n, cols);
  }
}

export class FrameError extends Error {
  constructor(message: string) { super(message); this.name = "FrameError"; }
}

/* ------------------------------- cell access -------------------------------- */

export function isNullAt(c: Column, i: number): boolean {
  switch (c.kind) {
    case "number": return Number.isNaN(c.values[i]!);
    case "date": return c.values[i] === NULL_DATE;
    case "string": return c.codes[i] === NULL_CODE;
    case "boolean": return c.values[i] === NULL_BOOL;
  }
}

/** Human-readable cell value (strings for dates/booleans); null for missing. */
export function cellValue(c: Column, i: number): string | number | boolean | null {
  switch (c.kind) {
    case "number": { const v = c.values[i]!; return Number.isNaN(v) ? null : v; }
    case "date": return c.values[i] === NULL_DATE ? null : c.values[i]!; // callers format via time.formatIsoDate
    case "string": return c.codes[i] === NULL_CODE ? null : c.dict[c.codes[i]!]!;
    case "boolean": return c.values[i] === NULL_BOOL ? null : c.values[i] === 1;
  }
}

/** Iterates a RowSet without allocating. */
export function rowCountOf(frame: Frame, rows: RowSet): number {
  return rows ? rows.length : frame.rowCount;
}

export function allRows(n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

/* ------------------------------- string dictionary -------------------------- */

export class DictBuilder {
  readonly dict: string[] = [];
  private readonly map = new Map<string, number>();
  code(value: string): number {
    let c = this.map.get(value);
    if (c === undefined) { c = this.dict.length; this.dict.push(value); this.map.set(value, c); }
    return c;
  }
}

/* ------------------------------- serialisation ------------------------------ */
// Container layout:  "TLF1" | u32 headerLen | header JSON (utf8) | column buffers (8-byte aligned)

const MAGIC = 0x31464c54; // "TLF1" little-endian

interface HeaderColumn {
  kind: ColumnKind;
  name: string;
  offset: number;
  bytes: number;
  meta?: NumberMeta | DateMeta;
  dict?: string[];
}

export function serializeFrame(frame: Frame): Uint8Array {
  const enc = new TextEncoder();
  let offset = 0;
  const parts: { col: Column; offset: number; bytes: number; view: Uint8Array }[] = [];
  const align8 = (n: number) => (n + 7) & ~7;
  for (const col of frame.columns) {
    const view =
      col.kind === "number" ? new Uint8Array(col.values.buffer, col.values.byteOffset, col.values.byteLength)
      : col.kind === "date" ? new Uint8Array(col.values.buffer, col.values.byteOffset, col.values.byteLength)
      : col.kind === "string" ? new Uint8Array(col.codes.buffer, col.codes.byteOffset, col.codes.byteLength)
      : new Uint8Array(col.values.buffer, col.values.byteOffset, col.values.byteLength);
    parts.push({ col, offset, bytes: view.byteLength, view });
    offset = align8(offset + view.byteLength);
  }
  const header = {
    v: 1,
    rowCount: frame.rowCount,
    columns: parts.map((p): HeaderColumn => {
      const h: HeaderColumn = { kind: p.col.kind, name: p.col.name, offset: p.offset, bytes: p.bytes };
      if (p.col.kind === "number" || p.col.kind === "date") h.meta = p.col.meta;
      if (p.col.kind === "string") h.dict = p.col.dict;
      return h;
    }),
  };
  const headerBytes = enc.encode(JSON.stringify(header));
  const dataStart = align8(8 + headerBytes.byteLength);
  const out = new Uint8Array(dataStart + offset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, headerBytes.byteLength, true);
  out.set(headerBytes, 8);
  for (const p of parts) out.set(p.view, dataStart + p.offset);
  return out;
}

export function deserializeFrame(buf: Uint8Array): Frame {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new FrameError("Not a Verinum frame container.");
  const headerLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + headerLen))) as { v: number; rowCount: number; columns: HeaderColumn[] };
  if (header.v !== 1) throw new FrameError(`Unsupported frame version ${header.v}.`);
  const dataStart = (8 + headerLen + 7) & ~7;
  const n = header.rowCount;
  const cols: Column[] = header.columns.map((h): Column => {
    // copy into aligned, owned buffers so typed-array views are always valid
    // NB: Node's Buffer#slice returns a view, not a copy — copy explicitly so this works for Buffers too
    const slice = new Uint8Array(h.bytes);
    slice.set(buf.subarray(dataStart + h.offset, dataStart + h.offset + h.bytes));
    switch (h.kind) {
      case "number": return { kind: "number", name: h.name, values: new Float64Array(slice.buffer, 0, n), meta: (h.meta ?? {}) as NumberMeta };
      case "date": return { kind: "date", name: h.name, values: new Int32Array(slice.buffer, 0, n), meta: (h.meta ?? {}) as DateMeta };
      case "string": return { kind: "string", name: h.name, codes: new Uint32Array(slice.buffer, 0, n), dict: h.dict ?? [] };
      case "boolean": return { kind: "boolean", name: h.name, values: new Uint8Array(slice.buffer, 0, n) };
    }
  });
  return new Frame(n, cols);
}
