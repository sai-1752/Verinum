import type { ChatMessage, LlmProvider, LlmRequest, LlmResponse, ToolCallRequest } from "@verinum/core";
import { readSse } from "./sse";
import { postJson, ProviderError, type ProviderHttp } from "./types";

export interface AnthropicOptions extends ProviderHttp { apiKey: string; model: string; baseUrl: string }

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export function toAnthropicMessages(messages: ChatMessage[]): { role: "user" | "assistant"; content: string | Block[] }[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user" as const, content: m.text };
    if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      return { role: "assistant" as const, content: blocks.length ? blocks : m.text };
    }
    return { role: "user" as const, content: m.results.map((r): Block => ({ type: "tool_result", tool_use_id: r.callId, content: r.content, ...(r.isError ? { is_error: true } : {}) })) };
  });
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(private readonly o: AnthropicOptions) {}
  get model() { return this.o.model; }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await postJson(this.o, "anthropic", `${this.o.baseUrl.replace(/\/$/, "")}/v1/messages`,
      { "x-api-key": this.o.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.o.model, max_tokens: req.maxTokens ?? 1500, stream: true, system: req.system, messages: toAnthropicMessages(req.messages),
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) } : {}),
      }, req.signal);

    let text = "";
    const blocks = new Map<number, { kind: "text" | "tool"; id?: string; name?: string; json: string }>();
    let stop: LlmResponse["stop"] = "other";
    let inputTokens = 0, outputTokens = 0;
    for await (const m of readSse(res)) {
      let ev: { type?: string; index?: number; message?: { usage?: { input_tokens?: number } }; content_block?: { type: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }; usage?: { output_tokens?: number }; error?: { message?: string } };
      try { ev = JSON.parse(m.data); } catch { continue; }
      switch (ev.type) {
        case "message_start": inputTokens = ev.message?.usage?.input_tokens ?? 0; break;
        case "content_block_start":
          blocks.set(ev.index ?? 0, { kind: ev.content_block?.type === "tool_use" ? "tool" : "text", id: ev.content_block?.id, name: ev.content_block?.name, json: "" });
          break;
        case "content_block_delta": {
          const b = blocks.get(ev.index ?? 0);
          if (ev.delta?.type === "text_delta" && ev.delta.text) { text += ev.delta.text; req.onText?.(ev.delta.text); }
          else if (ev.delta?.type === "input_json_delta" && b) b.json += ev.delta.partial_json ?? "";
          break;
        }
        case "message_delta":
          outputTokens = ev.usage?.output_tokens ?? outputTokens;
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason === "tool_use" ? "tool_use" : ev.delta.stop_reason === "max_tokens" ? "max_tokens" : ev.delta.stop_reason === "end_turn" || ev.delta.stop_reason === "stop_sequence" ? "end" : "other";
          break;
        case "error": throw new ProviderError("anthropic", null, `anthropic stream error: ${ev.error?.message ?? "unknown"}`.slice(0, 300), true);
      }
    }
    const toolCalls: ToolCallRequest[] = [];
    for (const [, b] of [...blocks].sort((a, b) => a[0] - b[0])) {
      if (b.kind !== "tool") continue;
      let args: unknown = {};
      try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = { __malformed: true }; }
      toolCalls.push({ id: b.id ?? `call_${toolCalls.length}`, name: b.name ?? "", args });
    }
    return { text, toolCalls, stop: toolCalls.length ? "tool_use" : stop, usage: { inputTokens, outputTokens } };
  }
}
