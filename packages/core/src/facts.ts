/**
 * Facts and provenance — the currency of the grounding contract.
 *
 * Every number that reaches a user (insight text, KPI, chat answer) is created through a
 * FactSet, which stores the exact value, its unit and the exact string that is displayed.
 * The grounding validator later checks that every numeric claim in an AI answer matches a fact
 * from a tool result in the same turn; a number that cannot be matched is never shown.
 */
import { formatValue, type FormatContext, type Unit } from "./format";

export interface Fact {
  /** unique within its FactSet ("f1", "f2", …) */
  id: string;
  label: string;
  value: number | string | boolean | null;
  unit: Unit;
  /** the exact string used in prose (formatted once, deterministically) */
  display: string;
}

export interface FactOptions {
  decimals?: number;
  compact?: boolean;
  /** show a leading + for positive values (changes and deltas) */
  signed?: boolean;
}

export class FactSet {
  readonly facts: Fact[] = [];
  private n = 0;
  constructor(readonly fmt: FormatContext = {}, private readonly prefix = "f") {}

  /** Records a numeric fact and returns it; use `.display` in text. */
  num(label: string, value: number | null | undefined, unit: Unit = "number", o: FactOptions = {}): Fact {
    const v = value === undefined || value === null || !Number.isFinite(value) ? null : value;
    let display = formatValue(v, unit, { ...this.fmt, compact: o.compact ?? (o.decimals !== undefined ? false : undefined), decimals: o.decimals });
    if (o.signed && v !== null && v > 0) display = `+${display}`;
    const f: Fact = { id: `${this.prefix}${++this.n}`, label, value: v, unit, display };
    this.facts.push(f);
    return f;
  }

  text(label: string, value: string, unit: Unit = "text"): Fact {
    const f: Fact = { id: `${this.prefix}${++this.n}`, label, value, unit, display: value };
    this.facts.push(f);
    return f;
  }

  merge(other: FactSet | Fact[]): void {
    const list = Array.isArray(other) ? other : other.facts;
    for (const f of list) this.facts.push({ ...f, id: `${this.prefix}${++this.n}` });
  }
}

/** Where a result came from — enough to reproduce it and to explain it to a user. */
export interface Provenance {
  tool: string;
  params: Record<string, unknown>;
  /** rows in scope after filters */
  rowsConsidered: number;
  filters: string[];
  /** the dataset version the numbers were computed on */
  datasetVersion?: string;
  period?: { from: string; to: string } | null;
  /** one sentence: how the number was calculated */
  method: string;
  caveats: string[];
}

/** A structured, machine-readable result plus the facts that back every number in it. */
export interface ToolResult<T = unknown> {
  ok: true;
  data: T;
  facts: Fact[];
  provenance: Provenance;
  /** a short deterministic summary the model may quote (built only from `facts`) */
  summary: string;
  chart?: import("./charts").ChartSpec;
}

export interface ToolFailure {
  ok: false;
  code: string;
  message: string;
  hint?: string;
}
