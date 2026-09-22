/**
 * A stand-in for the Anthropic Messages API, so the browser tests exercise the real grounded-chat path
 * (tool call -> computed result -> model wording -> verification) without network access or cost.
 *
 * Its behaviour is scripted by the wording of the question: it always asks for `top_n` first, then writes
 * a faithful answer, an answer with one invented figure ("best seller"), or fails ("outage").
 */
import { createServer } from "node:http";
import { anthropicText, anthropicToolUse, sse } from "../apps/api/test/helpers/mock-llm";

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? 4610);

const hasToolResult = (messages: any[]): boolean =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result"));

/** The person's latest typed question (tool results are also "user" messages and are skipped). */
const question = (messages: any[]): string => {
  for (const m of [...messages].reverse()) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const t = (m.content ?? []).find((b: any) => b?.type === "text");
    if (t) return String(t.text);
  }
  return "";
};

createServer((req, res) => {
  if (req.url === "/health") { res.end("ok"); return; }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body: any = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* ignore */ }
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    const q = question(body.messages ?? []).toLowerCase();

    // scenario: the provider is down -> the product must still answer, from the computed result alone
    if (q.includes("outage")) { res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"message":"simulated outage"}}'); return; }

    if (!hasToolResult(body.messages ?? [])) {
      sse(res, anthropicToolUse("toolu_e2e_1", "top_n", ['{"dimension":"Product",', '"n":5}']));
      return;
    }

    // scenario: the model adds an invented figure to an otherwise correct explanation
    if (q.includes("best seller")) {
      sse(res, anthropicText([
        "Aura Watch is the top product with 506.5K in Total Sales. ",
        "It holds 15.7% of the total. ",
        "Sales will reach 9.9M next quarter.\n",
      ]));
      return;
    }

    // default: a faithful answer (every figure exists in the tool result)
    sse(res, anthropicText([
      "The top five products by Total Sales are:\n",
      "Aura Watch: 506.5K (15.7% of the total)\n",
      "Nimbus Ring: 441.4K (13.7% of the total)\n",
      "Orbit Dock: 407.0K (12.6% of the total)\n",
      "Shield Case: 374.3K (11.6% of the total)\n",
      "Vista Hub: 364.7K (11.3% of the total)\n",
    ]));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock anthropic listening on ${port}`));
