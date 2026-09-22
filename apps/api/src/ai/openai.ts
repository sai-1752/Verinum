import type { ChatMessage, LlmProvider, LlmRequest, LlmResponse, ToolCallRequest } from "@verinum/core";
import { readSse } from "./sse";
import { postJson, ProviderError, type ProviderHttp } from "./types";

export interface OpenAiOptions extends ProviderHttp { apiKey: string; model: string; baseUrl: string }

type OaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: ChatMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant", content: m.text || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    } else for (const r of m.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.content });
  }
  return out;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  constructor(private readonly o: OpenAiOptions) {}
  get model() { return this.o.model; }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await postJson(this.o, "openai", `${this.o.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      { authorization: `Bearer ${this.o.apiKey}` },
      {
        model: this.o.model, max_completion_tokens: req.maxTokens ?? 1500, stream: true, stream_options: { include_usage: true },
        messages: toOpenAiMessages(req.system, req.messages),
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
      }, req.signal);

    let text = "";
    const calls = new Map<number, { id?: string; name: string; args: string }>();
    let finish: string | null = null;
    let inputTokens = 0, outputTokens = 0;
    for await (const m of readSse(res)) {
      if (m.data === "[DONE]") break;
      let ev: { choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
      try { ev = JSON.parse(m.data); } catch { continue; }
      if (ev.error) throw new ProviderError("openai", null, `openai stream error: ${ev.error.message ?? "unknown"}`.slice(0, 300), true);
      if (ev.usage) { inputTokens = ev.usage.prompt_tokens ?? inputTokens; outputTokens = ev.usage.completion_tokens ?? outputTokens; }
      const ch = ev.choices?.[0];
      if (!ch) continue;
      if (ch.delta?.content) { text += ch.delta.content; req.onText?.(ch.delta.content); }
      for (const tc of ch.delta?.tool_calls ?? []) {
        const c = calls.get(tc.index) ?? { name: "", args: "" };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        calls.set(tc.index, c);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    const toolCalls: ToolCallRequest[] = [...calls].sort((a, b) => a[0] - b[0]).map(([i, c]) => {
      let args: unknown = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { __malformed: true }; }
      return { id: c.id ?? `call_${i}`, name: c.name, args };
    });
    const stop: LlmResponse["stop"] = toolCalls.length ? "tool_use" : finish === "length" ? "max_tokens" : finish === "stop" ? "end" : "other";
    return { text, toolCalls, stop, usage: { inputTokens, outputTokens } };
  }
}
