/**
 * Object storage abstraction. Keys are always scoped `w/<workspaceId>/…`; `scoped()` returns a
 * handle that refuses any key outside its own workspace prefix, so a bug elsewhere cannot read or
 * overwrite another tenant's files. All objects are encrypted at rest when a key is configured.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AppError } from "../errors";

export interface ObjectStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** deletes everything under the prefix; returns how many objects were removed */
  deletePrefix(prefix: string): Promise<number>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_.=-]{0,400}$/;
export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.split("/").some((p) => p === ".." || p === "." || p === "")) throw new AppError(500, "storage_key", "Invalid storage key.");
}

export const wsPrefix = (workspaceId: string) => `w/${workspaceId}/`;
export const objectKey = (workspaceId: string, ...parts: string[]) => `${wsPrefix(workspaceId)}${parts.join("/")}`;

export class LocalStore implements ObjectStore {
  private readonly root: string;
  constructor(dir: string) { this.root = resolve(dir); }
  private path(key: string): string {
    assertKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new AppError(500, "storage_key", "Invalid storage key.");
    return p;
  }
  async put(key: string, data: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p);
  }
  async get(key: string): Promise<Uint8Array> {
    try { return new Uint8Array(await readFile(this.path(key))); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "not_found", "The stored file is missing.");
      throw e;
    }
  }
  async exists(key: string): Promise<boolean> { try { await stat(this.path(key)); return true; } catch { return false; } }
  async delete(key: string): Promise<void> { await rm(this.path(key), { force: true }); }
  async deletePrefix(prefix: string): Promise<number> {
    assertKey(prefix.replace(/\/$/, ""));
    const base = resolve(join(this.root, prefix));
    if (!base.startsWith(this.root + sep)) throw new AppError(500, "storage_key", "Invalid storage key.");
    let n = 0;
    const walk = async (d: string): Promise<void> => {
      let entries;
      try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) { if (e.isDirectory()) await walk(join(d, e.name)); else n++; }
    };
    await walk(base);
    await rm(base, { recursive: true, force: true });
    return n;
  }
}

/** AES-256-GCM wrapper. The object key is bound as AAD, so ciphertexts cannot be swapped between keys. */
export class EncryptedStore implements ObjectStore {
  private static readonly MAGIC = Buffer.from("TLE1");
  constructor(private readonly inner: ObjectStore, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  }
  async put(key: string, data: Uint8Array): Promise<void> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(key));
    const enc = Buffer.concat([c.update(data), c.final()]);
    await this.inner.put(key, Buffer.concat([EncryptedStore.MAGIC, iv, enc, c.getAuthTag()]));
  }
  async get(key: string): Promise<Uint8Array> {
    const buf = Buffer.from(await this.inner.get(key));
    if (buf.length < 4 + 12 + 16 || !buf.subarray(0, 4).equals(EncryptedStore.MAGIC)) throw new AppError(500, "storage_corrupt", "A stored file could not be read.");
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(4, 16));
    d.setAAD(Buffer.from(key));
    d.setAuthTag(buf.subarray(buf.length - 16));
    try { return new Uint8Array(Buffer.concat([d.update(buf.subarray(16, buf.length - 16)), d.final()])); } catch {
      throw new AppError(500, "storage_corrupt", "A stored file could not be read.");
    }
  }
  exists(key: string) { return this.inner.exists(key); }
  delete(key: string) { return this.inner.delete(key); }
  deletePrefix(prefix: string) { return this.inner.deletePrefix(prefix); }
}

export class S3Store implements ObjectStore {
  private client: import("@aws-sdk/client-s3").S3Client | null = null;
  constructor(private readonly o: { bucket: string; region: string; endpoint?: string; forcePathStyle?: boolean }) {}
  private async sdk() {
    const mod = await import("@aws-sdk/client-s3");
    this.client ??= new mod.S3Client({ region: this.o.region, endpoint: this.o.endpoint, forcePathStyle: this.o.forcePathStyle });
    return { mod, client: this.client };
  }
  async put(key: string, data: Uint8Array) { assertKey(key); const { mod, client } = await this.sdk(); await client.send(new mod.PutObjectCommand({ Bucket: this.o.bucket, Key: key, Body: data, ServerSideEncryption: "AES256" })); }
  async get(key: string) {
    assertKey(key);
    const { mod, client } = await this.sdk();
    try { const r = await client.send(new mod.GetObjectCommand({ Bucket: this.o.bucket, Key: key })); return new Uint8Array(await r.Body!.transformToByteArray()); } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") throw new AppError(404, "not_found", "The stored file is missing.");
      throw e;
    }
  }
  async exists(key: string) { assertKey(key); const { mod, client } = await this.sdk(); try { await client.send(new mod.HeadObjectCommand({ Bucket: this.o.bucket, Key: key })); return true; } catch { return false; } }
  async delete(key: string) { assertKey(key); const { mod, client } = await this.sdk(); await client.send(new mod.DeleteObjectCommand({ Bucket: this.o.bucket, Key: key })); }
  async deletePrefix(prefix: string) {
    const { mod, client } = await this.sdk();
    let n = 0, token: string | undefined;
    do {
      const r = await client.send(new mod.ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) { await client.send(new mod.DeleteObjectsCommand({ Bucket: this.o.bucket, Delete: { Objects: keys } })); n += keys.length; }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return n;
  }
}

/** A handle that can only touch keys under one workspace's prefix. */
export class ScopedStore {
  constructor(private readonly store: ObjectStore, readonly workspaceId: string) {}
  private check(key: string): string {
    if (!key.startsWith(wsPrefix(this.workspaceId))) throw new AppError(403, "forbidden", "Storage access outside the workspace was blocked.");
    return key;
  }
  key(...parts: string[]) { return objectKey(this.workspaceId, ...parts); }
  // async on purpose: a refused key always surfaces as a rejected promise, never a synchronous throw
  async put(key: string, data: Uint8Array) { return this.store.put(this.check(key), data); }
  async get(key: string) { return this.store.get(this.check(key)); }
  async exists(key: string) { return this.store.exists(this.check(key)); }
  async delete(key: string) { return this.store.delete(this.check(key)); }
  async deletePrefix(prefix: string) { return this.store.deletePrefix(this.check(prefix)); }
}

export interface StorageService { scoped(workspaceId: string): ScopedStore; raw: ObjectStore }

export function createStorage(store: ObjectStore): StorageService {
  return { scoped: (w) => new ScopedStore(store, w), raw: store };
}
