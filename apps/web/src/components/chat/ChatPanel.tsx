import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, post, streamChat } from "../../lib/api";
import { useConversation, useConversations, useStarterQuestions } from "../../lib/hooks";
import type { ChatAnswer, ChatMode, ChartSpec, Fact, SourceRef, StoredMessage } from "../../lib/types";
import { fmtRelative, titleCase } from "../../lib/format";
import { Badge, Button, ErrorNote, Notice, Popover, Spinner } from "../ui";
import { ChartView } from "../charts/ChartView";
import { ProvenancePanel } from "../analysis/Provenance";
import { VerifiedText } from "./VerifiedText";

interface ToolStep { callId: string; tool: string; status: "running" | "done" | "failed"; summary?: string }
interface Turn {
  key: string; role: "user" | "assistant"; text: string; messageId?: string; mode?: ChatMode; sources: SourceRef[]; charts: ChartSpec[]; facts: Fact[];
  followUps: string[]; warnings: string[]; grounding?: ChatAnswer["grounding"]; replaced?: boolean; feedback?: number | null; streaming?: boolean; steps: ToolStep[]; error?: string; errorCode?: string;
}

const fromStored = (m: StoredMessage): Turn => ({
  key: m.id, role: m.role, text: m.content, messageId: m.id, mode: m.mode ?? undefined, sources: m.sources ?? [], charts: m.charts ?? [], facts: [],
  followUps: m.followUps ?? [], warnings: m.warnings ?? [], grounding: m.grounding ?? undefined, feedback: m.feedback, steps: [],
});

const toolLabel = (t: string) => titleCase(t).toLowerCase();

function Thumb({ up, active, onClick }: { up: boolean; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={active} aria-label={up ? "This answer helped" : "This answer didn't help"} className={clsx("rounded p-1.5 hover:bg-sunk", active ? "text-thread" : "text-ink-3 hover:text-ink")}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={up ? undefined : { transform: "rotate(180deg)" }} aria-hidden>
        <path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2l-1.5 7A2 2 0 0 1 17.5 20H7" />
      </svg>
    </button>
  );
}

function AnswerTurn({ t, workspaceId, onAsk, onFeedback, isLast }: { t: Turn; workspaceId: string; onAsk: (q: string) => void; onFeedback: (t: Turn, v: number) => void; isLast: boolean }) {
  const [showSources, setShowSources] = useState(false);
  const running = t.steps.filter((s) => s.status === "running");
  const mode = t.mode;
  return (
    <div className="thread-rail">
      {t.streaming && !t.text && (
        <p className="flex items-center gap-2 text-sm text-ink-2" role="status">
          <span className="spinner" aria-hidden />
          {running.length ? `Calculating with ${toolLabel(running[0]!.tool)}…` : "Working out how to answer…"}
        </p>
      )}
      {t.steps.length > 0 && t.streaming && (
        <ul className="mb-2 space-y-0.5 text-xs text-ink-3" aria-label="Calculations in progress">
          {t.steps.map((s) => <li key={s.callId}>{s.status === "running" ? "Running" : s.status === "done" ? "Computed" : "Could not run"} {toolLabel(s.tool)}</li>)}
        </ul>
      )}
      {t.error ? (
        <ErrorNote error={new ApiError(0, t.errorCode ?? "error", t.error)} />
      ) : t.text ? (
        <VerifiedText text={t.text} facts={t.facts} sources={t.sources} mark={mode !== "no_answer"} streaming={t.streaming} />
      ) : null}

      {t.warnings.length > 0 && <div className="mt-3 space-y-1.5">{t.warnings.map((w, i) => <Notice key={i} tone="warn" className="!py-2">{w}</Notice>)}</div>}

      {!t.streaming && !t.error && (
        <>
          {t.charts.length > 0 && <div className="mt-4 space-y-5">{t.charts.slice(0, 2).map((c, i) => <div key={i} className="rounded-lg border border-line bg-panel p-4"><ChartView spec={c} height={240} /></div>)}</div>}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-3">
            {mode === "llm" && <Badge tone="thread">AI explained · every figure checked</Badge>}
            {mode === "deterministic" && <Badge>Computed answer</Badge>}
            {t.sources.length > 0 && <button className="underline underline-offset-2 hover:text-ink" onClick={() => setShowSources((s) => !s)} aria-expanded={showSources}>{showSources ? "Hide sources" : `Sources (${t.sources.length})`}</button>}
            {t.messageId && (
              <span className="ml-auto flex items-center">
                <Thumb up active={t.feedback === 1} onClick={() => onFeedback(t, t.feedback === 1 ? 0 : 1)} />
                <Thumb up={false} active={t.feedback === -1} onClick={() => onFeedback(t, t.feedback === -1 ? 0 : -1)} />
              </span>
            )}
          </div>

          {(t.replaced || (t.grounding && t.grounding.dropped > 0)) && (
            <p className="mt-2 text-xs text-ink-3">
              {t.replaced
                ? "The AI's wording didn't pass the figure check, so this shows the computed result instead."
                : `${t.grounding!.dropped} sentence${t.grounding!.dropped === 1 ? " was" : "s were"} left out because ${t.grounding!.dropped === 1 ? "its figures" : "their figures"} couldn't be traced to a calculation.`}
            </p>
          )}

          {showSources && (
            <ol className="mt-3 space-y-3">
              {t.sources.map((s) => (
                <li key={s.callId} className="rounded-md bg-sunk p-3">
                  <p className="text-xs font-medium text-ink">{titleCase(s.tool)}</p>
                  <p className="mt-1 whitespace-pre-line text-xs text-ink-2">{s.summary}</p>
                  <div className="mt-2 border-t border-line pt-2"><ProvenancePanel provenance={s.provenance} compact /></div>
                </li>
              ))}
            </ol>
          )}

          {isLast && t.followUps.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Suggested follow-up questions">
              {t.followUps.slice(0, 3).map((q) => <button key={q} onClick={() => onAsk(q)} className="rounded-full border border-line-2 bg-panel px-3 py-1.5 text-left text-xs text-ink-2 hover:border-thread hover:text-ink">{q}</button>)}
            </div>
          )}
        </>
      )}
      <span className="hidden">{workspaceId}</span>
    </div>
  );
}

export function ChatPanel({ workspaceId, datasetId, versionId, initialQuestion, canAsk = true }: { workspaceId: string; datasetId: string; versionId: string | null | undefined; initialQuestion?: string | null; canAsk?: boolean }) {
  const qc = useQueryClient();
  const base = `/workspaces/${workspaceId}/datasets/${datasetId}`;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const [loadId, setLoadId] = useState<string | null>(null);
  const conv = useConversation(workspaceId, datasetId, loadId);
  const history = useConversations(workspaceId, datasetId);
  const starters = useStarterQuestions(workspaceId, datasetId, versionId);

  useEffect(() => { if (conv.data && conv.data.id === loadId) { setTurns(conv.data.messages.map(fromStored)); setLoadId(null); } }, [conv.data, loadId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: turns.length > 2 ? "smooth" : "auto" }); }, [turns]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const patchLast = useCallback((fn: (t: Turn) => Turn) => setTurns((ts) => { const i = ts.length - 1; return i < 0 ? ts : [...ts.slice(0, i), fn(ts[i]!)]; }), []);

  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true); setInput("");
    const ac = new AbortController(); abortRef.current = ac;
    setTurns((ts) => [...ts, { key: `local-u-${Date.now()}`, role: "user", text: q, sources: [], charts: [], facts: [], followUps: [], warnings: [], steps: [] }, { key: `local-a-${Date.now()}`, role: "assistant", text: "", sources: [], charts: [], facts: [], followUps: [], warnings: [], steps: [], streaming: true }]);
    let cid = conversationId;
    try {
      await streamChat(`${base}/chat`, { message: q, ...(conversationId ? { conversationId } : {}) }, (e) => {
        if (e.type === "meta") { cid = e.conversationId; setConversationId(e.conversationId); }
        else if (e.type === "tool_start") patchLast((t) => ({ ...t, steps: [...t.steps, { callId: e.callId, tool: e.tool, status: "running" }] }));
        else if (e.type === "tool_result") patchLast((t) => ({ ...t, steps: t.steps.map((s) => (s.callId === e.callId ? { ...s, status: e.ok ? "done" : "failed", summary: e.summary } : s)) }));
        else if (e.type === "text") patchLast((t) => ({ ...t, text: t.text + e.delta }));
        else if (e.type === "error") patchLast((t) => ({ ...t, streaming: false, error: e.message }));
        else if (e.type === "final") {
          const a = e.answer;
          cid = a.conversationId;
          patchLast((t) => ({ ...t, streaming: false, text: a.answer, messageId: a.messageId, mode: a.mode, sources: a.sources, charts: a.charts, facts: a.facts, followUps: a.followUps, warnings: a.warnings, grounding: a.grounding, replaced: a.replaced, feedback: null }));
        }
      }, ac.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") patchLast((t) => ({ ...t, streaming: false, text: t.text || "Stopped.", error: undefined }));
      else patchLast((t) => ({ ...t, streaming: false, error: (e as Error).message, errorCode: e instanceof ApiError ? e.code : undefined }));
    } finally {
      setBusy(false); abortRef.current = null;
      void qc.invalidateQueries({ queryKey: ["conversations", workspaceId, datasetId] });
      void qc.invalidateQueries({ queryKey: ["usage", workspaceId] });
      if (cid) setConversationId(cid);
    }
  }, [base, busy, conversationId, patchLast, qc, workspaceId, datasetId]);

  // a question passed in the URL (from an insight or a dashboard tile) is asked once
  useEffect(() => { if (initialQuestion && canAsk && !started.current && versionId) { started.current = true; void ask(initialQuestion); } }, [initialQuestion, canAsk, versionId, ask]);

  const feedback = useCallback(async (t: Turn, v: number) => {
    if (!t.messageId) return;
    setTurns((ts) => ts.map((x) => (x.key === t.key ? { ...x, feedback: v || null } : x)));
    try { await post(`/workspaces/${workspaceId}/messages/${t.messageId}/feedback`, { value: v }); } catch { setTurns((ts) => ts.map((x) => (x.key === t.key ? { ...x, feedback: t.feedback ?? null } : x))); }
  }, [workspaceId]);

  const newChat = () => { abortRef.current?.abort(); setConversationId(null); setLoadId(null); setTurns([]); setInput(""); };
  const openConv = (id: string) => { abortRef.current?.abort(); setTurns([]); setConversationId(id); setLoadId(id); };
  const lastAssistant = useMemo(() => { for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.role === "assistant") return turns[i]!.key; return null; }, [turns]);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-15rem)] max-w-3xl flex-col">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-ink-2">Answers are calculated from your data. Numbers marked <span className="vnum">like this</span> were checked against those calculations.</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Popover label="Past conversations" align="right" trigger={({ toggle, open, id }) => <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open} aria-controls={id}>History</Button>}>
            {(close) => (
              <div className="max-h-72 w-72 overflow-auto">
                {!history.data?.length ? <p className="px-2 py-3 text-xs text-ink-3">No earlier conversations yet.</p> : history.data.map((c) => (
                  <button key={c.id} onClick={() => { openConv(c.id); close(); }} className={clsx("block w-full rounded px-2 py-1.5 text-left hover:bg-sunk", c.id === conversationId && "bg-thread-wash")}>
                    <span className="block truncate text-sm text-ink">{c.title || "Untitled"}</span>
                    <span className="text-xs text-ink-3">{fmtRelative(c.updatedAt)} · {c.messages} messages</span>
                  </button>
                ))}
              </div>
            )}
          </Popover>
          <Button size="sm" onClick={newChat} disabled={!turns.length}>New chat</Button>
        </div>
      </div>

      <div className="flex-1 space-y-7 pb-6" aria-live="polite" aria-busy={busy}>
        {loadId && !turns.length && <Spinner label="Loading conversation" />}
        {!turns.length && !loadId && (
          <div className="pt-4">
            <h2 className="text-2xl">What would you like to know?</h2>
            <p className="mt-1 text-sm text-ink-2">Ask in plain English. Try one of these, or type your own.</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {(starters.data ?? []).slice(0, 6).map((q) => <li key={q}><button disabled={!canAsk || busy} onClick={() => void ask(q)} className="w-full rounded-lg border border-line bg-panel px-3.5 py-2.5 text-left text-sm text-ink hover:border-thread disabled:opacity-50">{q}</button></li>)}
              {starters.isLoading && [0, 1, 2, 3].map((i) => <li key={i} className="skeleton h-11" />)}
            </ul>
          </div>
        )}
        {turns.map((t) => t.role === "user" ? (
          <div key={t.key} className="flex justify-start"><p className="max-w-prose rounded-lg bg-sunk px-3.5 py-2 text-[0.95rem] font-medium text-ink">{t.text}</p></div>
        ) : (
          <AnswerTurn key={t.key} t={t} workspaceId={workspaceId} onAsk={(q) => void ask(q)} onFeedback={feedback} isLast={t.key === lastAssistant} />
        ))}
        <div ref={endRef} />
      </div>

      <form className="sticky bottom-0 -mx-1 border-t border-line bg-paper/95 px-1 pb-4 pt-3 backdrop-blur" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        {!canAsk && <Notice tone="warn" className="mb-2">You don't have permission to ask questions in this workspace.</Notice>}
        <div className="flex items-end gap-2">
          <label htmlFor="ask-input" className="sr-only">Ask a question about this dataset</label>
          <textarea id="ask-input" rows={1} value={input} disabled={!canAsk} maxLength={2000} placeholder="Ask about this dataset…" data-testid="ask-input"
            onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(input); } }}
            className="input min-h-[2.75rem] flex-1 resize-none py-2.5 leading-6" />
          {busy ? <Button onClick={() => abortRef.current?.abort()} className="h-11">Stop</Button> : <Button type="submit" variant="primary" className="h-11" disabled={!input.trim() || !canAsk}>Ask</Button>}
        </div>
        <p className="mt-1.5 text-xs text-ink-3">Enter to send, Shift+Enter for a new line.</p>
      </form>
    </div>
  );
}
