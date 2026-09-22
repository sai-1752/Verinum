export class ProviderError extends Error {
  constructor(readonly provider: string, readonly status: number | null, message: string, readonly retryable = false) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderHttp {
  fetch: typeof fetch;
  timeoutMs: number;
}

/** Fetch with a timeout combined with the caller's abort signal, one retry on 429/5xx before any output. */
export async function postJson(http: ProviderHttp, provider: string, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  let last: ProviderError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = AbortSignal.timeout(http.timeoutMs);
    let res: Response;
    try {
      res = await http.fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      if (signal?.aborted) throw e;
      last = new ProviderError(provider, null, timeout.aborted ? "The AI provider timed out." : "The AI provider could not be reached.", true);
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 400)); continue; }
      throw last;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    // The body may echo request details; keep only a short, key-free excerpt for logs.
    const excerpt = (await res.text().catch(() => "")).replace(/(sk-|key-)[A-Za-z0-9_-]+/g, "***").slice(0, 300);
    last = new ProviderError(provider, res.status, `${provider} returned HTTP ${res.status}${excerpt ? `: ${excerpt}` : ""}`, retryable);
    if (retryable && attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
    throw last;
  }
  throw last!;
}
