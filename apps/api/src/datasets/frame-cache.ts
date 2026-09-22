/**
 * In-memory LRU of parsed datasets. Keys include the workspace id, so an entry can never be served
 * to a different tenant even if a version id were guessed; concurrent loads of the same version are
 * coalesced; memory is bounded by an estimated byte budget.
 */
import type { AnalysisContext, DatasetProfile, Frame } from "@verinum/core";

export interface LoadedDataset {
  versionId: string; frame: Frame; profile: DatasetProfile; bytes: number;
  /** unfiltered analysis context, shared across requests so derived series are computed once */
  ctx: AnalysisContext;
  /** the stored dashboard plan (widget specs + filter controls) */
  plan: unknown;
}

export function estimateFrameBytes(frame: Frame): number {
  let n = 0;
  for (const c of frame.columns) {
    switch (c.kind) {
      case "number": n += c.values.byteLength; break;
      case "date": n += c.values.byteLength; break;
      case "boolean": n += c.values.byteLength; break;
      case "string": n += c.codes.byteLength + c.dict.reduce((a, s) => a + s.length * 2 + 16, 0); break;
    }
  }
  return n;
}

export class FrameCache {
  private readonly entries = new Map<string, LoadedDataset>();
  private readonly pending = new Map<string, Promise<LoadedDataset>>();
  private total = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly maxBytes: number) {}

  private key(workspaceId: string, versionId: string) { return `${workspaceId}:${versionId}`; }

  async get(workspaceId: string, versionId: string, load: () => Promise<LoadedDataset>): Promise<LoadedDataset> {
    const k = this.key(workspaceId, versionId);
    const hit = this.entries.get(k);
    if (hit) { this.entries.delete(k); this.entries.set(k, hit); this.hits++; return hit; }
    const inflight = this.pending.get(k);
    if (inflight) return inflight;
    this.misses++;
    const p = load().then((d) => { this.put(k, d); return d; }).finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  private put(k: string, d: LoadedDataset) {
    if (d.bytes > this.maxBytes) return; // too big to cache: served once, never retained
    this.entries.set(k, d);
    this.total += d.bytes;
    while (this.total > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string;
      this.total -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  /** Drops every cached version of a dataset's workspace entry (after delete or reprocess). */
  evictVersion(workspaceId: string, versionId: string) {
    const k = this.key(workspaceId, versionId);
    const e = this.entries.get(k);
    if (e) { this.total -= e.bytes; this.entries.delete(k); }
  }
  evictWorkspace(workspaceId: string) {
    for (const [k, e] of [...this.entries]) if (k.startsWith(`${workspaceId}:`)) { this.total -= e.bytes; this.entries.delete(k); }
  }
  get size() { return this.entries.size; }
  get bytes() { return this.total; }
}
