import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, asOwner, Client, demoDataset, initDb, makeApp, PASSWORD, resetData, signup, uniqueEmail, type Session, type TestApp } from "./helpers/harness";

let t: TestApp;
beforeAll(async () => { await initDb(); t = await makeApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetData(); t.mailer.outbox.length = 0; });

const ws = (s: Session, p = "") => `/workspaces/${s.workspaceId}${p}`;

async function team() {
  const owner = await signup(t, "Olivia Owner");
  await asOwner((c) => c.query("update workspaces set plan_id = 'team' where id = $1", [owner.workspaceId])); // the free plan caps members at 3
  const admin = await addMember(t, owner, "admin");
  const analyst = await addMember(t, owner, "analyst");
  const viewer = await addMember(t, owner, "viewer");
  const { id } = await demoDataset(t, owner);
  return { owner, admin, analyst, viewer, dataset: id };
}

describe("role permissions over HTTP", () => {
  it("viewers can read and ask questions, but cannot create, change, delete or export data", async () => {
    const { viewer, dataset } = await team();
    expect((await viewer.client.get(ws(viewer, "/datasets"))).status).toBe(200);
    expect((await viewer.client.get(ws(viewer, `/datasets/${dataset}/insights`))).status).toBe(200);
    expect((await viewer.client.post(ws(viewer, `/datasets/${dataset}/chat`), { message: "What are the top 5 products?" })).status).toBe(200);
    expect((await viewer.client.upload(ws(viewer, "/datasets"), "x.csv", "a,b\n1,2\n")).status).toBe(403);
    expect((await viewer.client.post(ws(viewer, "/datasets/demo"))).status).toBe(403);
    expect((await viewer.client.patch(ws(viewer, `/datasets/${dataset}`), { name: "x" })).status).toBe(403);
    expect((await viewer.client.delete(ws(viewer, `/datasets/${dataset}`))).status).toBe(403);
    expect((await viewer.client.post(ws(viewer, `/datasets/${dataset}/reprocess`), {})).status).toBe(403);
    expect((await viewer.client.post(ws(viewer, `/datasets/${dataset}/export`), {})).status).toBe(403);
    expect((await viewer.client.post(ws(viewer, `/datasets/${dataset}/dashboards`), { name: "d", widgets: [{ id: "a", title: "t", tool: "top_n", params: {}, size: "md" }] })).status).toBe(403);
    expect((await viewer.client.get(ws(viewer, "/usage"))).status).toBe(403);
    expect((await viewer.client.get(ws(viewer, "/audit"))).status).toBe(403);
    expect((await viewer.client.get(ws(viewer, "/billing"))).status).toBe(403);
    expect((await viewer.client.post(ws(viewer, "/invitations"), { email: "a@b.co", role: "viewer" })).status).toBe(403);
    expect((await viewer.client.patch(ws(viewer), { name: "x" })).status).toBe(403);
    // and the viewer sees only viewer-appropriate parts of the members page
    expect((await viewer.client.get(ws(viewer, "/members"))).body.invitations).toEqual([]);
  });

  it("analysts work with data but cannot manage people, billing or the workspace", async () => {
    const { analyst, viewer, owner, dataset } = await team();
    expect((await analyst.client.post(ws(analyst, `/datasets/${dataset}/export`), { format: "csv" })).status).toBe(200);
    expect((await analyst.client.post(ws(analyst, `/datasets/${dataset}/dashboards`), { name: "d", widgets: [{ id: "a", title: "t", tool: "top_n", params: { dimension: "Product" }, size: "md" }] })).status).toBe(201);
    expect((await analyst.client.get(ws(analyst, "/usage"))).status).toBe(200);
    expect((await analyst.client.post(ws(analyst, "/invitations"), { email: uniqueEmail(), role: "viewer" })).status).toBe(403);
    expect((await analyst.client.patch(ws(analyst, `/members/${viewer.userId}`), { role: "admin" })).status).toBe(403);
    expect((await analyst.client.delete(ws(analyst, `/members/${viewer.userId}`))).status).toBe(403);
    expect((await analyst.client.delete(ws(analyst, `/members/${owner.userId}`))).status).toBe(403);
    expect((await analyst.client.patch(ws(analyst), { name: "mine now" })).status).toBe(403);
    expect((await analyst.client.get(ws(analyst, "/audit"))).status).toBe(403);
    expect((await analyst.client.post(ws(analyst, "/billing/checkout"), { plan: "pro" })).status).toBe(403);
    expect((await analyst.client.delete(ws(analyst), { confirm: "x" })).status).toBe(403);
  });

  it("admins manage analysts/viewers and read the audit log, but cannot touch admins/owners, billing, or delete the workspace", async () => {
    const { admin, owner, analyst, viewer } = await team();
    expect((await admin.client.get(ws(admin, "/audit"))).status).toBe(200);
    expect((await admin.client.patch(ws(admin), { name: "Renamed by admin" })).status).toBe(200);
    expect((await admin.client.patch(ws(admin, `/members/${viewer.userId}`), { role: "analyst" })).status).toBe(200);
    expect((await admin.client.post(ws(admin, "/invitations"), { email: uniqueEmail(), role: "viewer" })).status).toBe(201);
    // escalation attempts
    expect((await admin.client.post(ws(admin, "/invitations"), { email: uniqueEmail(), role: "admin" })).status).toBe(403);
    expect((await admin.client.patch(ws(admin, `/members/${analyst.userId}`), { role: "admin" })).status).toBe(403);
    expect((await admin.client.patch(ws(admin, `/members/${admin.userId}`), { role: "owner" })).status).toBe(403);
    expect((await admin.client.patch(ws(admin, `/members/${owner.userId}`), { role: "viewer" })).status).toBe(403);
    expect((await admin.client.delete(ws(admin, `/members/${owner.userId}`))).status).toBe(403);
    expect((await admin.client.post(ws(admin, "/billing/checkout"), { plan: "pro" })).status).toBe(403);
    expect((await admin.client.delete(ws(admin), { confirm: "Renamed by admin" })).status).toBe(403);
    expect((await admin.client.get(ws(admin, "/billing"))).status).toBe(200); // read-only
    const roles = Object.fromEntries((await owner.client.get(ws(owner, "/members"))).body.members.map((m: any) => [m.userId, m.role]));
    expect(roles[owner.userId]).toBe("owner");
    expect(roles[admin.userId]).toBe("admin");
    expect(roles[analyst.userId]).toBe("analyst");
    expect(roles[viewer.userId]).toBe("analyst"); // the one change that was allowed
  });

  it("owners can promote and demote, but the last owner can never be removed or demoted", async () => {
    const { owner, admin } = await team();
    const demote = await owner.client.patch(ws(owner, `/members/${owner.userId}`), { role: "admin" });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("last_owner");
    expect((await owner.client.delete(ws(owner, `/members/${owner.userId}`))).body.error.code).toBe("last_owner");
    expect((await owner.client.patch(ws(owner, `/members/${admin.userId}`), { role: "owner" })).status).toBe(200);
    expect((await owner.client.patch(ws(owner, `/members/${owner.userId}`), { role: "admin" })).status).toBe(200); // now allowed: another owner exists
    expect((await admin.client.get(ws(admin, "/billing"))).status).toBe(200);
    expect((await admin.client.post(ws(admin, "/billing/checkout"), { plan: "pro" })).status).toBe(501); // permitted (owner now), just not configured
  });

  it("a removed member loses access immediately; members can leave on their own", async () => {
    const { owner, analyst, viewer } = await team();
    expect((await analyst.client.get(ws(analyst, "/datasets"))).status).toBe(200);
    expect((await owner.client.delete(ws(owner, `/members/${analyst.userId}`))).status).toBe(200);
    expect((await analyst.client.get(ws(analyst, "/datasets"))).status).toBe(404);
    expect((await analyst.client.get("/auth/me")).body.workspaces.map((w: any) => w.id)).not.toContain(owner.workspaceId);
    expect((await viewer.client.delete(ws(viewer, `/members/${viewer.userId}`))).status).toBe(200); // leave
    expect((await viewer.client.get(ws(viewer, "/datasets"))).status).toBe(404);
  });
});

describe("invitations", () => {
  it("full flow: invite → email → new user accepts → gets exactly the invited role; token is single-use", async () => {
    const owner = await signup(t, "Owner");
    const email = uniqueEmail("guest");
    expect((await owner.client.post(ws(owner, "/invitations"), { email, role: "analyst" })).status).toBe(201);
    const token = t.mailer.last(email)!.text.match(/token=([\w-]+)/)![1]!;
    const preview = await new Client(t).get(`/invitations/preview?token=${token}`);
    expect(preview.body).toMatchObject({ workspaceName: "Owner's workspace", role: "analyst", email });
    expect(Object.keys(preview.body).sort()).toEqual(["email", "role", "workspaceName"]); // reveals nothing else
    const guest = await signup(t, "Guest", email);
    expect((await guest.client.post("/invitations/accept", { token })).body).toMatchObject({ workspaceId: owner.workspaceId, role: "analyst" });
    expect((await guest.client.get(ws(owner, "/datasets"))).status).toBe(200);
    expect((await guest.client.post("/invitations/accept", { token })).status).toBe(422);
    expect((await new Client(t).get(`/invitations/preview?token=${token}`)).status).toBe(422);
  });

  it("the invitation only works for the invited address, and revoked or re-issued invitations die", async () => {
    const owner = await signup(t, "Owner");
    const email = uniqueEmail("guest");
    await owner.client.post(ws(owner, "/invitations"), { email, role: "viewer" });
    const first = t.mailer.last(email)!.text.match(/token=([\w-]+)/)![1]!;
    const stranger = await signup(t, "Stranger");
    const r = await stranger.client.post("/invitations/accept", { token: first });
    expect(r.status).toBe(403);
    // re-inviting replaces the earlier link
    await owner.client.post(ws(owner, "/invitations"), { email, role: "analyst" });
    const second = t.mailer.last(email)!.text.match(/token=([\w-]+)/)![1]!;
    expect(second).not.toBe(first);
    const guest = await signup(t, "Guest", email);
    expect((await guest.client.post("/invitations/accept", { token: first })).status).toBe(422);
    // revoke the second
    const list = (await owner.client.get(ws(owner, "/members"))).body.invitations;
    expect(list).toHaveLength(1);
    expect((await owner.client.delete(ws(owner, `/invitations/${list[0].id}`))).status).toBe(200);
    expect((await guest.client.post("/invitations/accept", { token: second })).status).toBe(422);
  });

  it("cannot invite as owner, cannot invite an existing member, and expired invitations are rejected", async () => {
    const owner = await signup(t, "Owner");
    const viewer = await addMember(t, owner, "viewer");
    expect((await owner.client.post(ws(owner, "/invitations"), { email: uniqueEmail(), role: "owner" })).status).toBe(400);
    const dup = await owner.client.post(ws(owner, "/invitations"), { email: viewer.email, role: "viewer" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("already_member");
    const email = uniqueEmail("late");
    await owner.client.post(ws(owner, "/invitations"), { email, role: "viewer" });
    const token = t.mailer.last(email)!.text.match(/token=([\w-]+)/)![1]!;
    await asOwner((c) => c.query("update invitations set expires_at = now() - interval '1 minute' where email = $1", [email]));
    const late = await signup(t, "Late", email);
    expect((await late.client.post("/invitations/accept", { token })).status).toBe(422);
  });
});

describe("workspace lifecycle", () => {
  it("only the owner can delete, only with the exact name, and everything goes with it (rows and files)", async () => {
    const owner = await signup(t, "Owner");
    await demoDataset(t, owner);
    const nope = await owner.client.delete(ws(owner), { confirm: "wrong" });
    expect(nope.status).toBe(400);
    expect((await owner.client.delete(ws(owner), { confirm: "Owner's workspace" })).status).toBe(200);
    expect((await owner.client.get(ws(owner))).status).toBe(404);
    const left = await asOwner((c) => c.query("select (select count(*) from datasets)::int d, (select count(*) from dataset_versions)::int v, (select count(*) from memberships)::int m, (select count(*) from jobs)::int j, (select count(*) from workspaces)::int w"));
    expect(left.rows[0]).toEqual({ d: 0, v: 0, m: 0, j: 0, w: 0 });
    expect(await t.deps.storage.raw.deletePrefix(`w/${owner.workspaceId}/`)).toBe(0);
    const trail = await asOwner((c) => c.query("select action from audit_logs where workspace_id = $1 order by id", [owner.workspaceId]));
    expect(trail.rows.map((r) => r.action)).toContain("workspace.delete"); // the audit trail outlives the workspace
  });

  it("users may belong to several workspaces with different roles, each isolated", async () => {
    const a = await signup(t, "A");
    const b = await signup(t, "B");
    const guest = await addMember(t, a, "viewer");
    const mine = await guest.client.post("/workspaces", { name: "Guest's own" });
    const me = (await guest.client.get("/auth/me")).body.workspaces;
    expect(me.map((w: any) => w.role).sort()).toEqual(["owner", "owner", "viewer"]);
    expect(me.find((w: any) => w.id === mine.body.workspace.id).permissions).toContain("dataset.create");
    expect(me.find((w: any) => w.id === a.workspaceId).permissions).not.toContain("dataset.create");
    void b;
  });

  it("audit log records who did what, and cannot be altered", async () => {
    const { owner, viewer } = await team();
    await owner.client.patch(ws(owner, `/members/${viewer.userId}`), { role: "analyst" });
    const ev = (await owner.client.get(ws(owner, "/audit?limit=100"))).body.events;
    const changed = ev.find((e: any) => e.action === "member.role_changed");
    expect(changed).toMatchObject({ targetId: viewer.userId, meta: { from: "viewer", to: "analyst" } });
    expect(changed.actor.email).toBe(owner.email);
    expect(ev.map((e: any) => e.action)).toEqual(expect.arrayContaining(["member.invite", "member.joined", "dataset.create_demo", "dataset.processed"]));
    await expect(asOwner((c) => c.query("update audit_logs set action = 'x'"))).rejects.toThrow(/append-only/);
    await expect(asOwner((c) => c.query("delete from audit_logs"))).rejects.toThrow(/append-only/);
    // secrets never land in the trail
    expect(JSON.stringify(ev)).not.toMatch(new RegExp(PASSWORD));
  });
});
