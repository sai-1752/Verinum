/**
 * Bounded ZIP reading. OOXML files (xlsx, docx) are ZIP containers, which makes them a zip-bomb
 * vector. Every entry is inflated through a streaming decoder that counts the bytes actually
 * produced (not the sizes the archive claims) and aborts as soon as a limit is crossed.
 */
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { IngestError, type IngestLimits } from "./types";

export interface ZipEntry { name: string; data: Uint8Array }

function safeName(name: string): boolean {
  // never used as a filesystem path, but reject traversal and absolute names anyway
  return !name.includes("\0") && !name.startsWith("/") && !name.split(/[\\/]/).includes("..");
}

export interface ZipScan { names: string[]; totalBytes: number }

/**
 * Reads the entries whose names satisfy `want` (all when omitted) while enforcing every limit on
 * *all* entries, wanted or not — a bomb hidden in an unread entry is still a bomb.
 */
export function readZip(bytes: Uint8Array, limits: IngestLimits, want?: (name: string) => boolean): { entries: Map<string, Uint8Array>; scan: ZipScan } {
  const entries = new Map<string, Uint8Array>();
  const names: string[] = [];
  let total = 0;
  let count = 0;
  const fail = (m: string): never => { throw new IngestError("limit_exceeded", m, "The file expands to far more data than its size suggests. If it is legitimate, export it as CSV and upload that instead."); };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    count++;
    if (count > limits.maxZipEntries) fail(`The archive has more than ${limits.maxZipEntries} entries.`);
    names.push(file.name);
    if (!safeName(file.name)) fail("The archive contains an unsafe file name.");
    if (file.name.endsWith("/")) return;
    const keep = !want || want(file.name);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const compressed = typeof file.size === "number" ? file.size : 0;
    if (typeof file.originalSize === "number" && file.originalSize > limits.maxUncompressedBytes) fail("An entry in the archive is larger than the allowed size.");
    file.ondata = (err, chunk, final) => {
      if (err) throw new IngestError("corrupt", "The archive is damaged and could not be read.");
      size += chunk.length;
      total += chunk.length;
      if (total > limits.maxUncompressedBytes) fail("The archive expands beyond the allowed size.");
      if (size > 1024 * 1024 && compressed > 0 && size / compressed > limits.maxCompressionRatio) fail("An entry in the archive has an implausible compression ratio.");
      if (keep) chunks.push(chunk.slice());
      if (final && keep) entries.set(file.name, concat(chunks, size));
    };
    file.start();
  };
  try {
    unzip.push(bytes, true);
  } catch (e) {
    if (e instanceof IngestError) throw e;
    throw new IngestError("corrupt", "The file is damaged or not a valid archive.");
  }
  return { entries, scan: { names, totalBytes: total } };
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
