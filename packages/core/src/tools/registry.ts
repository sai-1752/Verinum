/**
 * Tool registry — the only way the AI can obtain a number.
 *
 * Tools are capability-gated: a tool is offered to the model only when the dataset supports it,
 * and unavailable capabilities are reported with a user-facing reason instead of being silently
 * hidden (so the model can say "forecasting isn't available because …" honestly).
 */
import { AnalyticsError } from "../analytics/errors";
import type { AnalysisContext } from "../context";
import type { ToolFailure, ToolResult } from "../facts";
import type { FactLedger } from "../grounding/ledger";
import { validate, type JsonSchema } from "./schema";

export interface ToolPolicy {
  /** allow tools to return individual rows (off by default: row-level data is never sent to the LLM) */
  exposeRows: boolean;
  maxResultRows: number;
}

export const DEFAULT_POLICY: ToolPolicy = { exposeRows: false, maxResultRows: 50 };

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** returns null when available, otherwise the user-facing reason it is not */
  gate?: (ctx: AnalysisContext) => string | null;
  /** the tool can return individual rows */
  rowLevel?: boolean;
  run: (ctx: AnalysisContext, params: Record<string, unknown>, policy: ToolPolicy) => ToolResult;
}

export interface OfferedTool { name: string; description: string; input_schema: JsonSchema }

/** Called with the real exception when a tool crashes; the model and user only ever see a generic message. */
export type InternalErrorHook = (err: unknown, info: { tool: string; params: unknown }) => void;

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDef>();
  constructor(defs: ToolDef[], readonly policy: ToolPolicy = DEFAULT_POLICY, private readonly onInternalError?: InternalErrorHook) {
    for (const d of defs) {
      if (this.byName.has(d.name)) throw new Error(`Duplicate tool ${d.name}`);
      this.byName.set(d.name, d);
    }
  }

  names(): string[] { return [...this.byName.keys()]; }
  get(name: string): ToolDef | undefined { return this.byName.get(name); }

  gateOf(ctx: AnalysisContext, def: ToolDef): string | null {
    if (def.rowLevel && !this.policy.exposeRows) return "Row-level examples are disabled for this workspace, so only aggregated results are available.";
    if (ctx.profile.rowCount === 0) return "The dataset has no rows.";
    return def.gate ? def.gate(ctx) : null;
  }

  /** Tools to offer the model for this dataset (JSON-schema function definitions). */
  offered(ctx: AnalysisContext): OfferedTool[] {
    return [...this.byName.values()]
      .filter((d) => this.gateOf(ctx, d) === null)
      .map((d) => ({ name: d.name, description: d.description, input_schema: { type: "object", ...d.parameters } as JsonSchema }));
  }

  /** Capabilities that are off, with the reason — given to the model as context. */
  unavailable(ctx: AnalysisContext): { tool: string; reason: string }[] {
    const out: { tool: string; reason: string }[] = [];
    for (const d of this.byName.values()) {
      const r = this.gateOf(ctx, d);
      if (r) out.push({ tool: d.name, reason: r });
    }
    return out;
  }

  /**
   * Executes a tool. Never throws for expected problems: bad arguments, unavailable capabilities and
   * analytic refusals come back as a ToolFailure the model can read and react to.
   */
  call(ctx: AnalysisContext, name: string, args: unknown, o: { callId?: string; ledger?: FactLedger } = {}): ToolResult | ToolFailure {
    const def = this.byName.get(name);
    if (!def) return { ok: false, code: "unknown_tool", message: `There is no tool named "${name}".`, hint: `Available tools: ${this.offered(ctx).map((t) => t.name).join(", ")}` };
    const gate = this.gateOf(ctx, def);
    if (gate) return { ok: false, code: "not_available", message: gate };
    const v = validate(args, def.parameters);
    if (!v.ok) return { ok: false, code: "invalid_arguments", message: v.error ?? "Invalid arguments.", hint: "Check the tool's parameter schema." };
    try {
      const res = def.run(ctx, v.value ?? {}, this.policy);
      o.ledger?.addResult(o.callId ?? `${name}#${o.ledger.size}`, res);
      return res;
    } catch (e) {
      if (e instanceof AnalyticsError) return { ok: false, code: e.code, message: e.message, hint: e.hint };
      // Unexpected: log for operators, never leak internals to the model or the user.
      try { this.onInternalError?.(e, { tool: name, params: v.value }); } catch { /* logging must never break a call */ }
      return { ok: false, code: "internal_error", message: "That analysis could not be completed." };
    }
  }
}
