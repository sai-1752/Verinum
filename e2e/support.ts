import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, type APIRequestContext, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");
export const WEB = "http://127.0.0.1:4173";
export const PASSWORD = "Correct-Horse-Battery-9";
export const OUTBOX = resolve(here, ".outbox");
export const DEMO_CSV = resolve(ROOT, "apps/api/assets/demo-retail-sales.csv");

let n = 0;
export const uniqueEmail = (p = "user") => `${p}.${Date.now().toString(36)}${n++}@example.com`;

export interface Account { email: string; password: string; name: string; workspaceId: string }

/** Sends API calls the way the browser does (same origin, cookies kept by the context). */
export const apiHeaders = { origin: WEB };

/** Creates an account through the API (used for set-up that is not the thing being tested). */
export async function createAccount(name = "Test Person", email = uniqueEmail("acct")): Promise<Account> {
  const api = await request.newContext({ baseURL: WEB, extraHTTPHeaders: apiHeaders });
  const r = await api.post("/api/v1/auth/register", { data: { name, email, password: PASSWORD } });
  expect(r.status(), await r.text()).toBe(201);
  const body = await r.json();
  await api.dispose();
  return { email, password: PASSWORD, name, workspaceId: body.workspaceId };
}

/** Signs the page's browser context in (no UI), so a test can start where it needs to. */
export async function signIn(page: Page, a: Pick<Account, "email" | "password">): Promise<void> {
  const r = await page.request.post("/api/v1/auth/login", { data: { email: a.email, password: a.password }, headers: apiHeaders });
  expect(r.status(), await r.text()).toBe(200);
}

export const apiFor = (page: Page): APIRequestContext => page.request;
export const get = async (page: Page, path: string) => (await page.request.get(`/api/v1${path}`)).json();
export const post = async (page: Page, path: string, data: unknown = {}) => page.request.post(`/api/v1${path}`, { data, headers: apiHeaders });

interface MailFile { to: string; subject: string; text: string }
/** Polls the file-based mail outbox for the newest message to `to` whose subject matches. */
export async function waitForMail(to: string, subject: RegExp, timeoutMs = 15_000): Promise<MailFile> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(OUTBOX)) {
      const found = readdirSync(OUTBOX).sort().reverse()
        .map((f) => JSON.parse(readFileSync(resolve(OUTBOX, f), "utf8")) as MailFile)
        .find((m) => m.to === to && subject.test(m.subject));
      if (found) return found;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No mail to ${to} matching ${subject} arrived`);
}
export const linkIn = (m: MailFile): string => {
  const url = m.text.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error(`No link in mail: ${m.text}`);
  return url;
};

/** Registers through the real form. */
export async function registerViaUi(page: Page, o: { name?: string; email?: string; password?: string } = {}): Promise<Account> {
  const email = o.email ?? uniqueEmail("ui");
  await page.goto("/register");
  await page.getByLabel("Your name").fill(o.name ?? "Sai Tester");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(o.password ?? PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/w\/[^/]+/);
  const workspaceId = page.url().match(/\/w\/([^/?#]+)/)![1]!;
  return { email, password: o.password ?? PASSWORD, name: o.name ?? "Sai Tester", workspaceId };
}

/** Fails the test if the page logs an error or throws (network 401 for signed-out probes is expected). */
export function watchConsole(page: Page): () => string[] {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 40[134]/.test(m.text())) problems.push(`console: ${m.text()}`); });
  return () => problems;
}

/** Four days of data: below the six complete periods a forecast needs. */
export const SMALL_CSV = [
  "Date,Region,Product,Sales,Quantity",
  ...Array.from({ length: 4 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    return `${d},${["North", "South", "East"][i % 3]},${["Kettle", "Toaster"][i % 2]},${100 + ((i * 37) % 90)},${1 + (i % 4)}`;
  }),
].join("\n");
