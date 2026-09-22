/** A local HTTP server that speaks just enough of the Anthropic / OpenAI streaming APIs for adapter tests. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockCall { path: string; headers: IncomingMessage["headers"]; body: any }
export type Responder = (call: MockCall, res: ServerResponse, n: number) => void;

export class MockLlm {
  server!: Server;
  calls: MockCall[] = [];
  url = "";
  constructor(private readonly respond: Responder) {}
  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const call = { path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
        this.calls.push(call);
        this.respond(call, res, this.calls.length);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop(): Promise<void> { return new Promise((r) => { this.server.closeAllConnections?.(); this.server.close(() => r()); }); }
}

export const sse = (res: ServerResponse, frames: { event?: string; data: unknown }[], splitAt = 0) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const text = frames.map((f) => `${f.event ? `event: ${f.event}\n` : ""}data: ${typeof f.data === "string" ? f.data : JSON.stringify(f.data)}\n\n`).join("");
  // deliver in awkward pieces to exercise the parser's buffering
  if (splitAt) { res.write(text.slice(0, splitAt)); setTimeout(() => { res.write(text.slice(splitAt)); res.end(); }, 5); } else { res.write(text); res.end(); }
};

export const anthropicText = (parts: string[], usage = { in: 50, out: 12 }) => [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: usage.in } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  ...parts.map((t) => ({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } })),
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.out } } },
  { event: "message_stop", data: { type: "message_stop" } },
];

export const anthropicToolUse = (id: string, name: string, json: string[]) => [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 80 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } } },
  ...json.map((j) => ({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: j } } })),
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } } },
];

export const openaiText = (parts: string[]) => [
  ...parts.map((t) => ({ data: { choices: [{ delta: { content: t }, finish_reason: null }] } })),
  { data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
  { data: { choices: [], usage: { prompt_tokens: 60, completion_tokens: 9 } } },
  { data: "[DONE]" },
];

export const openaiToolCall = (id: string, name: string, args: string[]) => [
  { data: { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args[0] ?? "" } }] }, finish_reason: null }] } },
  ...args.slice(1).map((a) => ({ data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a } }] }, finish_reason: null }] } })),
  { data: { choices: [{ delta: {}, finish_reason: "tool_calls" }] } },
  { data: "[DONE]" },
];
