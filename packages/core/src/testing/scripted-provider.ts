/**
 * A scripted LlmProvider for tests and offline demos. It plays back a fixed sequence of model turns
 * (text and/or tool calls), streaming text in small chunks so the SentenceGate is exercised exactly
 * as it is with a real streaming provider.
 */
import type { LlmProvider, LlmRequest, LlmResponse, ToolCallRequest } from "../chat";

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Omit<ToolCallRequest, "id">[] | ((req: LlmRequest) => Omit<ToolCallRequest, "id">[]);
  /** throw instead of answering (provider outage) */
  throws?: Error;
  chunk?: number;
}

export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "scripted-1";
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly turns: ScriptedTurn[]) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined, onText: undefined }) as LlmRequest);
    const t = this.turns[Math.min(this.i, this.turns.length - 1)]!;
    this.i++;
    if (t.throws) throw t.throws;
    const text = t.text ?? "";
    const size = t.chunk ?? 7;
    for (let k = 0; k < text.length; k += size) req.onText?.(text.slice(k, k + size));
    const calls = (typeof t.toolCalls === "function" ? t.toolCalls(req) : t.toolCalls) ?? [];
    const toolCalls = calls.map((c, n) => ({ ...c, id: `t${this.i}_${n}` }));
    return { text, toolCalls, stop: toolCalls.length ? "tool_use" : "end", usage: { inputTokens: 100 + text.length, outputTokens: Math.ceil(text.length / 4) } };
  }
}
