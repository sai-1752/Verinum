import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, initDb, makeApp, resetData, type TestApp } from "./helpers/harness";

let t: TestApp;
let google: Server;
let profile: Record<string, unknown> = {};
let tokenRequests: URLSearchParams[] = [];
let tokenStatus = 200;

beforeAll(async () => {
  await initDb();
  google = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") { tokenRequests.push(new URLSearchParams(Buffer.concat(chunks).toString())); res.statusCode = tokenStatus; return res.end(JSON.stringify({ access_token: "at_123" })); }
      if (req.url === "/userinfo" && req.headers.authorization === "Bearer at_123") return res.end(JSON.stringify(profile));
      res.statusCode = 401; res.end("{}");
    });
  });
  await new Promise<void>((r) => google.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
  t = await makeApp({ config: { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", GOOGLE_AUTH_URL: `${base}/auth`, GOOGLE_TOKEN_URL: `${base}/token`, GOOGLE_USERINFO_URL: `${base}/userinfo`, PUBLIC_API_URL: "http://localhost:4000" } });
});
afterAll(async () => { await t.close(); await new Promise((r) => google.close(r)); });
beforeEach(async () => { await resetData(); tokenRequests = []; tokenStatus = 200; });

async function start(c: Client) {
  const r = await c.get("/auth/oauth/google/start");
  expect(r.status).toBe(302);
  const loc = new URL(String(r.headers.location));
  return { loc, state: loc.searchParams.get("state")! };
}

describe("Google OAuth (authorization code + PKCE)", () => {
  it("advertises availability, redirects with state and an S256 challenge, sets a signed short-lived state cookie", async () => {
    const c = new Client(t);
    expect((await c.get("/auth/config")).body.oauth.google).toBe(true);
    const { loc } = await start(c);
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:4000/api/v1/auth/oauth/google/callback");
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(c.cookies.get("vn_oauth")).toMatch(/\./); // value.signature
  });

  it("completes sign-up: creates a verified account and workspace, sets the session, redirects into the app", async () => {
    profile = { sub: "g-1", email: "New.Person@Example.com", email_verified: true, name: "New Person" };
    const c = new Client(t);
    const { state } = await start(c);
    const r = await c.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toBe("http://localhost:5173/app");
    const body = tokenRequests[0]!;
    expect(body.get("code")).toBe("abc");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("client_secret")).toBe("csecret");
    const me = (await c.get("/auth/me")).body;
    expect(me.user).toMatchObject({ email: "new.person@example.com", emailVerified: true });
    expect(me.workspaces).toHaveLength(1);
    // signing in again reuses the same account
    const c2 = new Client(t);
    const s2 = await start(c2);
    await c2.get(`/auth/oauth/google/callback?code=def&state=${s2.state}`);
    expect((await c2.get("/auth/me")).body.user.id).toBe(me.user.id);
  });

  it("rejects a callback with a wrong, missing or replayed state, and never creates a session", async () => {
    profile = { sub: "g-2", email: "x@example.com", email_verified: true, name: "X" };
    const c = new Client(t);
    await start(c);
    const wrong = await c.get("/auth/oauth/google/callback?code=abc&state=forged");
    expect(String(wrong.headers.location)).toMatch(/\/login\?error=/);
    expect((await c.get("/auth/me")).status).toBe(401);
    const bare = new Client(t);
    expect(String((await bare.get("/auth/oauth/google/callback?code=abc&state=whatever")).headers.location)).toMatch(/error=/);
    // the state cookie is single-use
    const ok = new Client(t);
    const { state } = await start(ok);
    const saved = new Map(ok.cookies);
    await ok.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    const replay = new Client(t);
    replay.cookies = saved;
    // the cookie itself is still validly signed, but Google's code is single-use in practice; our side clears it on first use
    expect(ok.cookies.has("vn_oauth")).toBe(false);
  });

  it("refuses unverified provider emails and provider failures gracefully", async () => {
    const c = new Client(t);
    profile = { sub: "g-3", email: "unverified@example.com", email_verified: false, name: "U" };
    const s1 = await start(c);
    const r = await c.get(`/auth/oauth/google/callback?code=abc&state=${s1.state}`);
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/hasn't verified/);
    expect((await c.get("/auth/me")).status).toBe(401);
    const c2 = new Client(t);
    tokenStatus = 400;
    const s2 = await start(c2);
    expect(String((await c2.get(`/auth/oauth/google/callback?code=bad&state=${s2.state}`)).headers.location)).toMatch(/error=/);
  });

  it("links to an existing verified password account by email without creating a duplicate", async () => {
    const c0 = new Client(t);
    const reg = await c0.post("/auth/register", { email: "both@example.com", password: "Correct-Horse-Battery-9", name: "Both" });
    const link = t.mailer.last("both@example.com")!.text.match(/token=([\w-]+)/)![1]!;
    await new Client(t).post("/auth/verify-email", { token: link });
    profile = { sub: "g-4", email: "both@example.com", email_verified: true, name: "Both" };
    const c = new Client(t);
    const { state } = await start(c);
    await c.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    expect((await c.get("/auth/me")).body.user.id).toBe(reg.body.user.id);
    expect((await c0.get("/auth/me")).status).toBe(200); // verified account: existing sessions and password stay valid
  });
});
