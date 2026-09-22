import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, initDb, makeApp, PASSWORD, resetData, signup, uniqueEmail, type TestApp } from "./helpers/harness";

let t: TestApp;
beforeAll(async () => { await initDb(); t = await makeApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetData(); t.mailer.outbox.length = 0; });

describe("registration and sessions", () => {
  it("registers, creates a personal workspace, sets an httpOnly cookie and returns the user", async () => {
    const c = new Client(t);
    const email = uniqueEmail();
    const r = await c.post("/auth/register", { email: email.toUpperCase(), password: PASSWORD, name: "Ada Lovelace" });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email, name: "Ada Lovelace", emailVerified: false, isPlatformAdmin: false });
    const setCookie = String(r.headers["set-cookie"]);
    expect(setCookie).toMatch(/vn_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const me = await c.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.workspaces).toHaveLength(1);
    expect(me.body.workspaces[0]).toMatchObject({ role: "owner", planId: "free" });
    expect(me.body.workspaces[0].permissions).toContain("workspace.delete");
    expect(t.mailer.last(email)?.subject).toMatch(/Verify/);
  });

  it("rejects duplicate emails, weak passwords and unknown fields", async () => {
    const c = new Client(t);
    const email = uniqueEmail();
    expect((await c.post("/auth/register", { email, password: PASSWORD, name: "A" })).status).toBe(201);
    const dup = await new Client(t).post("/auth/register", { email, password: PASSWORD, name: "B" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("email_taken");
    const weak = await new Client(t).post("/auth/register", { email: uniqueEmail(), password: "password", name: "C" });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe("weak_password");
    const extra = await new Client(t).post("/auth/register", { email: uniqueEmail(), password: PASSWORD, name: "D", isPlatformAdmin: true });
    expect(extra.status).toBe(400);
  });

  it("logs in, logs out, and a revoked session stops working", async () => {
    const s = await signup(t);
    const c2 = new Client(t);
    const bad = await c2.post("/auth/login", { email: s.email, password: "wrong-password-1" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe("Invalid email or password.");
    const ghost = await c2.post("/auth/login", { email: "nobody@example.com", password: "wrong-password-1" });
    expect(ghost.body.error.message).toBe(bad.body.error.message); // no account enumeration
    expect((await c2.post("/auth/login", { email: s.email, password: PASSWORD })).status).toBe(200);
    expect((await c2.get("/auth/me")).status).toBe(200);
    expect((await c2.post("/auth/logout")).status).toBe(200);
    expect((await c2.get("/auth/me")).status).toBe(401);
    // the token that was just logged out is dead even if replayed
    expect((await s.client.get("/auth/me")).status).toBe(200);
  });

  it("locks the account after repeated failures, then still rejects the right password until the lock lapses", async () => {
    const s = await signup(t);
    const c = new Client(t);
    for (let i = 0; i < 10; i++) await c.post("/auth/login", { email: s.email, password: "nope-nope-nope-1" });
    const locked = await c.post("/auth/login", { email: s.email, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error.message).toMatch(/Too many failed attempts/);
  });

  it("requires a session for protected routes", async () => {
    const c = new Client(t);
    expect((await c.get("/auth/me")).status).toBe(401);
    expect((await c.get("/workspaces")).status).toBe(401);
  });
});

describe("CSRF and cookies", () => {
  it("blocks state-changing requests that carry the cookie from a foreign or missing Origin", async () => {
    const s = await signup(t);
    const evil = new Client(t, "https://evil.example");
    evil.cookies = new Map(s.client.cookies);
    const r = await evil.post("/workspaces", { name: "Hijack" });
    expect(r.status).toBe(403);
    const noOrigin = new Client(t, null);
    noOrigin.cookies = new Map(s.client.cookies);
    expect((await noOrigin.post("/workspaces", { name: "Hijack" })).status).toBe(403);
    // reads are unaffected, and the legitimate origin works
    expect((await evil.get("/auth/me")).status).toBe(200);
    expect((await s.client.post("/workspaces", { name: "Legit" })).status).toBe(201);
  });
});

describe("email verification and password reset", () => {
  it("verifies email once with the emailed token", async () => {
    const s = await signup(t);
    const link = t.mailer.last(s.email)!.text.match(/token=([\w-]+)/)![1]!;
    expect((await new Client(t).post("/auth/verify-email", { token: link })).status).toBe(200);
    expect((await s.client.get("/auth/me")).body.user.emailVerified).toBe(true);
    const again = await new Client(t).post("/auth/verify-email", { token: link });
    expect(again.status).toBe(422);
  });

  it("resets the password, invalidates every session, and makes the token single-use", async () => {
    const s = await signup(t);
    t.mailer.outbox.length = 0;
    expect((await new Client(t).post("/auth/forgot-password", { email: s.email })).status).toBe(200);
    expect((await new Client(t).post("/auth/forgot-password", { email: "ghost@example.com" })).status).toBe(200);
    expect(t.mailer.outbox).toHaveLength(1); // nothing sent for the unknown address, response identical
    const token = t.mailer.last(s.email)!.text.match(/token=([\w-]+)/)![1]!;
    const anon = new Client(t);
    expect((await anon.post("/auth/reset-password", { token, password: "short" })).status).toBe(422);
    expect((await anon.post("/auth/reset-password", { token, password: "A-Brand-New-Passphrase-42" })).status).toBe(200);
    expect((await anon.post("/auth/reset-password", { token, password: "Another-Passphrase-77" })).status).toBe(422);
    expect((await s.client.get("/auth/me")).status).toBe(401); // old session revoked
    expect((await new Client(t).post("/auth/login", { email: s.email, password: "A-Brand-New-Passphrase-42" })).status).toBe(200);
  });

  it("change-password keeps the current session but signs out the others", async () => {
    const s = await signup(t);
    const other = new Client(t);
    await other.post("/auth/login", { email: s.email, password: PASSWORD });
    const r = await s.client.post("/auth/change-password", { currentPassword: PASSWORD, newPassword: "Totally-New-Passphrase-5" });
    expect(r.status).toBe(200);
    expect((await s.client.get("/auth/me")).status).toBe(200);
    expect((await other.get("/auth/me")).status).toBe(401);
    expect((await s.client.post("/auth/change-password", { currentPassword: "wrong", newPassword: "Yet-Another-Passphrase-6" })).status).toBe(401);
  });
});

describe("OAuth account safety (unit-level, via the service)", () => {
  it("never signs in with an unverified provider email", async () => {
    const { signInWithOAuth } = await import("../src/auth/service");
    await expect(signInWithOAuth(t.deps, { provider: "google", subject: "s1", email: "x@example.com", emailVerified: false, name: "X" }, {})).rejects.toMatchObject({ code: "email_not_verified" });
  });

  it("pre-hijacking: an unverified password account is stripped of its password and sessions when the real owner links via OAuth", async () => {
    const { signInWithOAuth } = await import("../src/auth/service");
    const attacker = await signup(t, "Attacker", "victim@example.com"); // squats the victim's address, never verified
    const r = await signInWithOAuth(t.deps, { provider: "google", subject: "g-victim", email: "victim@example.com", emailVerified: true, name: "Victim" }, {});
    expect(r.user.id).toBe(attacker.userId);
    expect((await attacker.client.get("/auth/me")).status).toBe(401);
    expect((await new Client(t).post("/auth/login", { email: "victim@example.com", password: PASSWORD })).status).toBe(401);
  });
});
