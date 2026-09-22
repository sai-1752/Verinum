import type { ChatOutcome, Fact, GroundingReport } from "@verinum/core";
import type { Deps } from "../context";
import type { Q } from "../db";
import { notFound } from "../errors";
import { inWorkspace, isUuid, type WorkspaceCtx } from "../workspaces/service";

export const MAX_MESSAGE_CHARS = 2000;

/**
 * What clients may see about grounding: counts only. The text of removed sentences and the numbers
 * in them are kept server-side for quality review (the `grounding` column) and never sent back —
 * otherwise "untraceable numbers are never output" would be false in the API even if true in the UI.
 */
export const publicGrounding = (g: Partial<GroundingReport> | null) => g ? { sentences: g.sentences ?? 0, numericSentences: g.numericSentences ?? 0, dropped: g.dropped ?? 0, dropRatio: g.dropRatio ?? 0 } : null;
const MAX_FACTS_STORED = 300;

export async function listConversations(deps: Deps, ctx: WorkspaceCtx, datasetId: string) {
  return inWorkspace(deps, ctx, async (q) => (await q.query<{ id: string; title: string; updated_at: Date; messages: number }>(
    `select c.id, c.title, c.updated_at, (select count(*)::int from messages m where m.conversation_id = c.id) messages
     from conversations c where c.dataset_id = $1 and c.user_id = $2 order by c.updated_at desc limit 100`, [datasetId, ctx.userId]))
    .rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, messages: r.messages })));
}

/** Conversations are private to their author, even from other members of the workspace. */
async function ownConversation(q: Q, ctx: WorkspaceCtx, datasetId: string, id: string) {
  if (!isUuid(id)) throw notFound("Conversation");
  const c = (await q.query<{ id: string; title: string }>("select id, title from conversations where id = $1 and dataset_id = $2 and user_id = $3", [id, datasetId, ctx.userId])).rows[0];
  if (!c) throw notFound("Conversation");
  return c;
}

export async function getConversation(deps: Deps, ctx: WorkspaceCtx, datasetId: string, id: string) {
  return inWorkspace(deps, ctx, async (q) => {
    const c = await ownConversation(q, ctx, datasetId, id);
    const m = await q.query<{ id: string; role: string; content: string; mode: string | null; sources: unknown; charts: unknown; grounding: unknown; warnings: unknown; follow_ups: unknown; feedback: number | null; created_at: Date }>(
      "select id, role, content, mode, sources, charts, grounding, warnings, follow_ups, feedback, created_at from messages where conversation_id = $1 order by created_at, id", [id]);
    return { id: c.id, title: c.title, messages: m.rows.map((r) => ({ id: r.id, role: r.role, content: r.content, mode: r.mode, sources: r.sources, charts: r.charts, grounding: publicGrounding(r.grounding as GroundingReport | null), warnings: r.warnings, followUps: r.follow_ups, feedback: r.feedback, createdAt: r.created_at })) };
  });
}

export async function deleteConversation(deps: Deps, ctx: WorkspaceCtx, datasetId: string, id: string) {
  await inWorkspace(deps, ctx, async (q) => { await ownConversation(q, ctx, datasetId, id); await q.query("delete from conversations where id = $1", [id]); });
}

/** Starts a turn: finds or creates the conversation, stores the user message and returns prior context. */
export async function beginTurn(deps: Deps, ctx: WorkspaceCtx, o: { datasetId: string; conversationId?: string; message: string }) {
  return inWorkspace(deps, ctx, async (q) => {
    let conversationId = o.conversationId;
    if (conversationId) await ownConversation(q, ctx, o.datasetId, conversationId);
    else {
      const title = o.message.replace(/\s+/g, " ").trim().slice(0, 60);
      conversationId = (await q.query<{ id: string }>("insert into conversations (workspace_id, dataset_id, user_id, title) values ($1,$2,$3,$4) returning id", [ctx.workspaceId, o.datasetId, ctx.userId, title])).rows[0]!.id;
    }
    const prior = await q.query<{ role: "user" | "assistant"; content: string; facts: Fact[] | null }>(
      "select role, content, facts from messages where conversation_id = $1 order by created_at desc, id desc limit 12", [conversationId]);
    const history = prior.rows.reverse().map((r) => ({ role: r.role, text: r.content }));
    // facts from the latest assistant turns, so follow-ups such as "and last year?" may restate earlier numbers
    const priorFacts = prior.rows.filter((r) => r.role === "assistant" && r.facts).slice(-2).flatMap((r) => r.facts!);
    await q.query("insert into messages (workspace_id, conversation_id, role, content) values ($1,$2,'user',$3)", [ctx.workspaceId, conversationId, o.message]);
    return { conversationId, history, priorFacts };
  });
}

export async function finishTurn(deps: Deps, ctx: WorkspaceCtx, conversationId: string, out: ChatOutcome): Promise<string> {
  return inWorkspace(deps, ctx, async (q) => {
    const id = (await q.query<{ id: string }>(
      `insert into messages (workspace_id, conversation_id, role, content, mode, sources, charts, grounding, facts, warnings, follow_ups, usage, provider, model)
       values ($1,$2,'assistant',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [ctx.workspaceId, conversationId, out.answer, out.mode, JSON.stringify(out.sources), JSON.stringify(out.charts), JSON.stringify(out.grounding),
        JSON.stringify(out.facts.slice(0, MAX_FACTS_STORED)), JSON.stringify(out.warnings), JSON.stringify(out.followUps), JSON.stringify(out.usage), out.provider, out.model])).rows[0]!.id;
    await q.query("update conversations set updated_at = now() where id = $1", [conversationId]);
    return id;
  });
}

export async function setFeedback(deps: Deps, ctx: WorkspaceCtx, messageId: string, value: -1 | 0 | 1) {
  if (!isUuid(messageId)) throw notFound("Message");
  await inWorkspace(deps, ctx, async (q) => {
    // only the author of the conversation may rate its answers
    const r = await q.query(
      `update messages m set feedback = $2 from conversations c
       where m.id = $1 and c.id = m.conversation_id and c.user_id = $3 and m.role = 'assistant'`, [messageId, value === 0 ? null : value, ctx.userId]);
    if (!r.rowCount) throw notFound("Message");
  });
}
