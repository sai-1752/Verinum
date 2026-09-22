import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 96 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))));
}

/** scrypt$N$r$p$salt$hash — parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // always do the work, even for a missing account, so timing does not reveal which emails exist
  const parts = (stored ?? DUMMY).split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const key = await scryptAsync(password, Buffer.from(parts[4]!, "base64"), n, r, p);
  const ok = timingSafeEqual(key, Buffer.from(parts[5]!, "base64"));
  return ok && stored !== null;
}
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(KEYLEN).toString("base64")}`;

const COMMON = new Set(["password", "password1", "password123", "1234567890", "qwertyuiop", "letmein123", "iloveyou123", "admin12345", "welcome123", "changeme123"]);

export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  if (COMMON.has(password.toLowerCase())) return "That password is too common.";
  if (email && password.toLowerCase().includes(email.split("@")[0]!.toLowerCase()) && email.split("@")[0]!.length >= 4) return "Don't include your email name in the password.";
  if (/^(.)\1+$/.test(password)) return "Choose a less repetitive password.";
  return null;
}

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();
