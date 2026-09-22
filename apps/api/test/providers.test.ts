import { afterEach, describe, expect, it } from "vitest";
import { buildProfile, createContext, createToolRegistry, runChat, type LlmProvider, type OfferedTool } from "@verinum/core";
import { AnthropicProvider, OpenAiProvider, ProviderError } from "../src/ai";
import { toAnthropicMessages } from "../src/ai/anthropic";
import { toOpenAiMessages } from "../src/ai/openai";
import { readSse } from "../src/ai/sse";
import { anthropicText, anthropicToolUse, MockLlm, openaiText, openaiToolCall, sse } from "./helpers/mock-llm";
import { buildFrame } from "@verinum/core";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

const servers: MockLlm[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.stop())); });
const start = async (m: MockLlm) => { servers.push(m); return m.start(); };
const http = (timeoutMs = 5000) => ({ fetch, timeoutMs });
const tool: OfferedTool = { name: "top_n", description: "d", input_schema: { type: "object", properties: { dimension: { type: "string" } } } };

describe("SSE reader", () => {
  it("handles events split across chunks, CRLF and multi-line data", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode("event: a\r\ndata: 1\r\n\r\nda")); c.enqueue(enc.encode("ta: 2\ndata: 3\n\n: comment\n\ndata: [DONE]\n\n")); c.close(); } });
    const out: unknown[] = [];
    for await (const m of readSse(new Response(body))) out.push(m);
    expect(out).toEqual([{ event: "a", data: "1" }, { data: "2\n3" }, { data: "[DONE]" }]);
  });
});

describe("Anthropic adapter", () => {
  it("streams text, reports usage and sends the tool schema and auth headers", async () => {
    const m = await start(new MockLlm((_c, res) => sse(res, anthropicText(["Hello ", "world."]), 40)));
    const p = new AnthropicProvider({ ...http(), apiKey: "sk-test", model: "m1", baseUrl: m.url });
    const deltas: string[] = [];
    const r = await p.complete({ system: "SYS", messages: [{ role: "user", text: "hi" }], tools: [tool], onText: (d) => deltas.push(d) });
    expect(r).toMatchObject({ text: "Hello world.", stop: "end", usage: { inputTokens: 50, outputTokens: 12 } });
    expect(deltas.join("")).toBe("Hello world.");
    const c = m.calls[0]!;
    expect(c.path).toBe("/v1/messages");
    expect(c.headers["x-api-key"]).toBe("sk-test");
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.body).toMatchObject({ model: "m1", stream: true, system: "SYS", messages: [{ role: "user", content: "hi" }], tools: [{ name: "top_n" }] });
  });

  it("assembles a tool call from partial JSON deltas", async () => {
    const m = await start(new MockLlm((_c, res) => sse(res, anthropicToolUse("tu_1", "top_n", ['{"dimen', 'sion":"Prod', 'uct","n":5}']))));
    const r = await new AnthropicProvider({ ...http(), apiKey: "k", model: "m", baseUrl: m.url }).complete({ system: "s", messages: [{ role: "user", text: "q" }], tools: [tool] });
    expect(r.stop).toBe("tool_use");
    expect(r.toolCalls).toEqual([{ id: "tu_1", name: "top_n", args: { dimension: "Product", n: 5 } }]);
  });

  it("maps tool turns to tool_use / tool_result blocks", () => {
    const msgs = toAnthropicMessages([
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "top_n", args: { n: 1 } }] },
      { role: "tool", results: [{ callId: "a", name: "top_n", content: "{}", isError: true }] },
    ]);
    expect(msgs[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "a", name: "top_n", input: { n: 1 } }] });
    expect(msgs[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "{}", is_error: true }] });
  });

  it("retries once on 429 and then succeeds", async () => {
    const m = await start(new MockLlm((_c, res, n) => { if (n === 1) { res.writeHead(429); res.end("slow down"); } else sse(res, anthropicText(["ok"])); }));
    const r = await new AnthropicProvider({ ...http(), apiKey: "k", model: "m", baseUrl: m.url }).complete({ system: "s", messages: [{ role: "user", text: "q" }], tools: [] });
    expect(r.text).toBe("ok");
    expect(m.calls).toHaveLength(2);
  });

  it("surfaces persistent failures as ProviderError without leaking the key", async () => {
    const m = await start(new MockLlm((_c, res) => { res.writeHead(401); res.end('{"error":"bad key sk-ant-SECRET123"}'); }));
    const err = await new AnthropicProvider({ ...http(), apiKey: "sk-ant-SECRET123", model: "m", baseUrl: m.url }).complete({ system: "s", messages: [], tools: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain("SECRET123");
    expect(m.calls).toHaveLength(1); // 401 is not retried
  });

  it("times out on a stalled provider", async () => {
    const m = await start(new MockLlm(() => { /* never respond */ }));
    const err = await new AnthropicProvider({ ...http(150), apiKey: "k", model: "m", baseUrl: m.url }).complete({ system: "s", messages: [], tools: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/timed out/);
  });

  it("stops when the caller aborts", async () => {
    const m = await start(new MockLlm(() => { /* never respond */ }));
    const ac = new AbortController();
    const p = new AnthropicProvider({ ...http(), apiKey: "k", model: "m", baseUrl: m.url }).complete({ system: "s", messages: [], tools: [], signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow();
  });
});

describe("OpenAI adapter", () => {
  it("streams text and usage", async () => {
    const m = await start(new MockLlm((_c, res) => sse(res, openaiText(["Hi ", "there"]), 25)));
    const r = await new OpenAiProvider({ ...http(), apiKey: "sk-x", model: "gpt", baseUrl: m.url }).complete({ system: "SYS", messages: [{ role: "user", text: "hi" }], tools: [tool] });
    expect(r).toMatchObject({ text: "Hi there", stop: "end", usage: { inputTokens: 60, outputTokens: 9 } });
    const c = m.calls[0]!;
    expect(c.path).toBe("/v1/chat/completions");
    expect(c.headers.authorization).toBe("Bearer sk-x");
    expect(c.body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(c.body.tools[0]).toMatchObject({ type: "function", function: { name: "top_n" } });
  });

  it("assembles streamed tool-call arguments", async () => {
    const m = await start(new MockLlm((_c, res) => sse(res, openaiToolCall("call_1", "top_n", ['{"dimension":', '"Region"}']))));
    const r = await new OpenAiProvider({ ...http(), apiKey: "k", model: "g", baseUrl: m.url }).complete({ system: "s", messages: [{ role: "user", text: "q" }], tools: [tool] });
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "top_n", args: { dimension: "Region" } }]);
    expect(r.stop).toBe("tool_use");
  });

  it("maps tool results to role:tool messages", () => {
    const msgs = toOpenAiMessages("S", [
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "t", args: { a: 1 } }] },
      { role: "tool", results: [{ callId: "c1", name: "t", content: "R" }] },
    ]);
    expect(msgs[2]).toMatchObject({ role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "t", arguments: '{"a":1}' } }] });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "R" });
  });

  it("flags malformed tool arguments instead of guessing", async () => {
    const m = await start(new MockLlm((_c, res) => sse(res, openaiToolCall("c", "top_n", ['{"dimension": ']))));
    const r = await new OpenAiProvider({ ...http(), apiKey: "k", model: "g", baseUrl: m.url }).complete({ system: "s", messages: [], tools: [tool] });
    expect(r.toolCalls[0]!.args).toEqual({ __malformed: true });
  });
});

describe("grounded chat over a real provider adapter (mock HTTP server)", () => {
  const rows = parse(readFileSync(new URL("../assets/demo-retail-sales.csv", import.meta.url), "utf8")) as string[][];
  const frame = buildFrame({ columns: rows[0]!, rows: rows.slice(1) }).frame;
  const ctx = createContext(frame, buildProfile(frame));
  const registry = createToolRegistry();

  it("tool round-trip: model calls top_n, then explains; a fabricated number is dropped", async () => {
    let stage = 0;
    const m = await start(new MockLlm((c, res) => {
      stage++;
      if (stage === 1) return sse(res, anthropicToolUse("tu1", "top_n", ['{"dimension":"Product","n":5}']));
      const toolResult = JSON.stringify(c.body.messages.at(-1));
      expect(toolResult).toContain("tool_result");
      return sse(res, anthropicText(["Aura Watch leads with 506.5K in Total Sales. ", "It holds 15.7% of the total. ", "That is a 999% jump over last year."]));
    }));
    const provider: LlmProvider = new AnthropicProvider({ ...http(), apiKey: "k", model: "m", baseUrl: m.url });
    const events: string[] = [];
    const out = await runChat({ ctx, registry, question: "What are the top 5 products?", provider }, (e) => events.push(e.type));
    expect(out.mode).toBe("llm");
    expect(out.answer).toContain("506.5K");
    expect(out.answer).not.toContain("999");
    expect(out.grounding.dropped).toBe(1);
    expect(out.sources[0]!.tool).toBe("top_n");
    expect(events).toContain("tool_result");
  });

  it("provider outage falls back to the deterministic answer", async () => {
    const m = await start(new MockLlm((_c, res) => { res.writeHead(503); res.end("down"); }));
    const provider = new OpenAiProvider({ ...http(), apiKey: "k", model: "g", baseUrl: m.url });
    const out = await runChat({ ctx, registry, question: "What are the top 5 products?", provider }, () => undefined);
    expect(out.mode).toBe("deterministic");
    expect(out.answer).toContain("506.5K");
  });
});
