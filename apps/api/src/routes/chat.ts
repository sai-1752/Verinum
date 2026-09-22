import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { narrow, runChat, type ChatEvent, type ChatOutcome, type Filter } from "@verinum/core";
import type { Deps } from "../context";
import { loadForAnalysis } from "../datasets/service";
import { beginTurn, deleteConversation, finishTurn, getConversation, listConversations, MAX_MESSAGE_CHARS, publicGrounding, setFeedback } from "../chat/service";
import { hasAllowance, record } from "../usage";
import { parse, workspaceFor } from "./util";
import { Filters } from "./analysis";

/** Caps concurrent model calls per process so a burst can't exhaust provider quota or memory. */
class Gate {
  private active = 0;
  constructor(private readonly max: number) {}
  tryEnter(): boolean { if (this.active >= this.max) return false; this.active++; return true; }
  leave() { this.active = Math.max(0, this.active - 1); }
}

export async function registerChatRoutes(app: FastifyInstance, deps: Deps) {
  const base = "/workspaces/:workspaceId/datasets/:datasetId";
  const gate = new Gate(16);
  const dsId = (req: { params: unknown }) => (req.params as { datasetId: string }).datasetId;
  const chatLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.get(`${base}/conversations`, async (req) => ({ conversations: await listConversations(deps, await workspaceFor(deps, req, "chat.ask"), dsId(req)) }));
  app.get(`${base}/conversations/:id`, async (req) => getConversation(deps, await workspaceFor(deps, req, "chat.ask"), dsId(req), (req.params as { id: string }).id));
  app.delete(`${base}/conversations/:id`, async (req) => {
    await deleteConversation(deps, await workspaceFor(deps, req, "chat.ask"), dsId(req), (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/workspaces/:workspaceId/messages/:messageId/feedback", async (req) => {
    const ctx = await workspaceFor(deps, req, "chat.ask");
    const body = parse(z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).strict(), req.body);
    await setFeedback(deps, ctx, (req.params as { messageId: string }).messageId, body.value);
    return { ok: true };
  });

  /**
   * Ask a question. With `Accept: text/event-stream` the answer streams as server-sent events
   * (tool_start, tool_result, text, final); otherwise the completed answer is returned as JSON.
   */
  app.post(`${base}/chat`, chatLimit, async (req, reply) => {
    const ctx = await workspaceFor(deps, req, "chat.ask");
    const body = parse(z.object({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS), conversationId: z.string().uuid().optional(), filters: Filters }).strict(), req.body);
    const d = await loadForAnalysis(deps, ctx, dsId(req));
    const scope = body.filters.length ? narrow(d.ctx, body.filters as Filter[]) : d.ctx;
    const turn = await beginTurn(deps, ctx, { datasetId: dsId(req), conversationId: body.conversationId, message: body.message });

    // Plan gate: the AI explanation is metered. Over the limit, answers stay available in deterministic form.
    const warnings: string[] = [];
    let provider = deps.ai;
    if (provider && !ctx.plan.features.aiChat) { provider = null; warnings.push("AI explanations aren't included in your plan; showing the computed result."); }
    else if (provider && !(await hasAllowance(deps, ctx, "ai_message"))) { provider = null; warnings.push("You've used this month's AI messages, so this answer shows the computed result without an AI explanation."); }
    let entered = false;
    if (provider) { entered = gate.tryEnter(); if (!entered) { provider = null; warnings.push("The AI service is busy right now; showing the computed result."); } }

    const wantsStream = String(req.headers.accept ?? "").includes("text/event-stream");
    const ac = new AbortController();
    req.raw.on("close", () => { if (!reply.raw.writableEnded) ac.abort(); });
    let write: (event: string, data: unknown) => void = () => undefined;
    let heartbeat: NodeJS.Timeout | null = null;

    if (wantsStream) {
      reply.hijack();
      reply.raw.writeHead(200, { ...reply.getHeaders() as Record<string, string>, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      write = (event, data) => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      heartbeat = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(": keep-alive\n\n"); }, 15_000);
      write("meta", { conversationId: turn.conversationId });
    }

    let outcome: ChatOutcome;
    try {
      outcome = await runChat({
        ctx: scope, registry: deps.registry, question: body.message, history: turn.history, priorFacts: turn.priorFacts, provider,
        datasetName: d.dataset.name, signal: ac.signal, maxTokens: deps.config.AI_MAX_OUTPUT_TOKENS,
        onInternalError: (err, where) => req.log.error({ err, where }, "chat internal error"),
      }, (e: ChatEvent) => { if (e.type !== "final") write(e.type, e); });
    } catch (e) {
      if (entered) gate.leave();
      if (heartbeat) clearInterval(heartbeat);
      if (wantsStream) { write("error", { message: "The answer could not be completed. Please try again.", requestId: req.id }); reply.raw.end(); return reply; }
      throw e;
    }
    if (entered) gate.leave();
    outcome.warnings.push(...warnings);

    const messageId = await finishTurn(deps, ctx, turn.conversationId, outcome);
    if (outcome.mode === "llm") await record(deps, ctx, "ai_message", { conversationId: turn.conversationId, tokens: outcome.usage });
    deps.metrics.inc("chat_messages_total", { mode: outcome.mode });
    deps.metrics.inc("chat_dropped_sentences_total", {}, outcome.grounding.dropped);

    const payload = { conversationId: turn.conversationId, messageId, ...outcome, grounding: publicGrounding(outcome.grounding) };
    if (wantsStream) {
      if (heartbeat) clearInterval(heartbeat);
      write("final", payload);
      reply.raw.end();
      return reply;
    }
    return payload;
  });
}
