import type { ChatAnswer } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>, readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
  get isPlanLimit() { return this.status === 402 && this.code === "plan_limit"; }
}

const BASE = "/api/v1";
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => { onUnauthorized = fn; };

async function toError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown>; requestId?: string } } | null = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const e = body?.error;
  return new ApiError(res.status, e?.code ?? "error", e?.message ?? (res.status >= 500 ? "Something went wrong on our side. Please try again." : "The request failed."), e?.details, e?.requestId);
}

export interface RequestOptions { method?: string; body?: unknown; form?: FormData; query?: Record<string, string | number | undefined | null>; signal?: AbortSignal; quiet401?: boolean }

export async function api<T = unknown>(path: string, o: RequestOptions = {}): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: "application/json" };
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.body); }
  let res: Response;
  try {
    res = await fetch(url, { method: o.method ?? (body ? "POST" : "GET"), headers, body, credentials: "same-origin", signal: o.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    const err = await toError(res);
    if (res.status === 401 && !o.quiet401) onUnauthorized?.();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? await res.json() : await res.text()) as T;
}

export const get = <T>(path: string, query?: RequestOptions["query"], signal?: AbortSignal) => api<T>(path, { query, signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** Downloads a file produced by the server (exports). */
export async function download(path: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!res.ok) throw await toError(res);
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------ chat streaming (SSE over fetch) ------------------------------ */

export type StreamEvent =
  | { type: "meta"; conversationId: string }
  | { type: "tool_start"; callId: string; tool: string; params: unknown }
  | { type: "tool_result"; callId: string; tool: string; ok: boolean; summary?: string; message?: string }
  | { type: "text"; delta: string }
  | { type: "final"; answer: ChatAnswer }
  | { type: "error"; message: string };

/** Parses `event:`/`data:` frames from a text stream; tolerant of chunk boundaries anywhere. */
export function createSseParser(onFrame: (event: string, data: string) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) onFrame(event, data.join("\n"));
    }
  };
}

export async function streamChat(path: string, body: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), credentials: "same-origin", signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await toError(res);
  if (!res.body) throw new ApiError(0, "network", "The answer could not be streamed.");
  const parse = createSseParser((event, data) => {
    let d: any; try { d = JSON.parse(data); } catch { return; }
    if (event === "final") onEvent({ type: "final", answer: d });
    else if (event === "error") onEvent({ type: "error", message: d.message ?? "The answer could not be completed." });
    else if (event === "meta") onEvent({ type: "meta", conversationId: d.conversationId });
    else if (event === "text") onEvent({ type: "text", delta: d.delta ?? "" });
    else if (event === "tool_start") onEvent({ type: "tool_start", callId: d.callId, tool: d.tool, params: d.params });
    else if (event === "tool_result") onEvent({ type: "tool_result", callId: d.callId, tool: d.tool, ok: !!d.ok, summary: d.summary, message: d.message });
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parse(dec.decode(value, { stream: true }));
  }
  parse(dec.decode() + "\n\n");
}
