import { expect, test } from "@playwright/test";
import { apiHeaders, createAccount, get, linkIn, post, registerViaUi, signIn, uniqueEmail, waitForMail } from "../support";

test.describe("teams, roles and tenant isolation", () => {
  test("AC21 · another workspace's data is unreachable: by URL, by API, and by guessing ids", async ({ page, browser }) => {
    const alice = await createAccount("Alice Owner");
    await signIn(page, alice);
    const demo = await (await post(page, `/workspaces/${alice.workspaceId}/datasets/demo`)).json();
    await expect.poll(async () => (await get(page, `/workspaces/${alice.workspaceId}/datasets/${demo.datasetId}`)).status, { timeout: 60_000 }).toBe("ready");

    const mallory = await createAccount("Mallory Other");
    const ctx = await browser.newContext();
    const mp = await ctx.newPage();
    await signIn(mp, mallory);
    // in the browser
    await mp.goto(`/w/${alice.workspaceId}/datasets/${demo.datasetId}/overview`);
    await expect(mp.getByTestId("dataset-title")).toHaveCount(0);
    await expect(mp.getByText(/not found|doesn't exist|can't find/i).first()).toBeVisible();
    // in the API: every route that names Alice's workspace is a 404, not a 403 (existence is not revealed)
    for (const path of [
      `/workspaces/${alice.workspaceId}`,
      `/workspaces/${alice.workspaceId}/datasets`,
      `/workspaces/${alice.workspaceId}/datasets/${demo.datasetId}`,
      `/workspaces/${alice.workspaceId}/datasets/${demo.datasetId}/rows`,
      `/workspaces/${alice.workspaceId}/datasets/${demo.datasetId}/insights`,
      `/workspaces/${alice.workspaceId}/members`,
      `/workspaces/${alice.workspaceId}/audit`,
    ]) expect((await mp.request.get(`/api/v1${path}`)).status(), path).toBe(404);
    // her own workspace with Alice's dataset id: nothing there either
    expect((await mp.request.get(`/api/v1/workspaces/${mallory.workspaceId}/datasets/${demo.datasetId}`)).status()).toBe(404);
    const chat = await mp.request.post(`/api/v1/workspaces/${alice.workspaceId}/datasets/${demo.datasetId}/chat`, { data: { message: "top 5 products" }, headers: apiHeaders });
    expect(chat.status()).toBe(404);
    // and Mallory's own list is empty
    expect((await (await mp.request.get(`/api/v1/workspaces/${mallory.workspaceId}/datasets`)).json()).datasets).toEqual([]);
    await ctx.close();
  });

  test("invitations: an invited person joins with the invited role, and a viewer cannot change data", async ({ page, browser }) => {
    const owner = await registerViaUi(page, { name: "Olive Owner" });
    await page.goto(`/w/${owner.workspaceId}/members`);
    const invitee = uniqueEmail("viewer");
    await page.getByLabel("Email").fill(invitee);
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByTestId("invitation-row")).toContainText(invitee);
    const link = linkIn(await waitForMail(invitee, /invited you/i));

    const ctx = await browser.newContext();
    const vp = await ctx.newPage();
    await vp.goto(link);
    await expect(vp.getByRole("heading", { name: /Join Olive's workspace/ })).toBeVisible();
    await vp.getByRole("link", { name: "Create an account to join" }).click();
    await vp.getByLabel("Your name").fill("Vic Viewer");
    await vp.getByLabel("Work email").fill(invitee);
    await vp.getByLabel("Password").fill("Correct-Horse-Battery-9");
    await vp.getByRole("button", { name: "Create account" }).click();
    await vp.getByRole("button", { name: "Accept invitation" }).click();
    await vp.waitForURL(new RegExp(`/w/${owner.workspaceId}`));

    // a viewer sees the data but is offered no way to change it
    await expect(vp.getByTestId("upload-button")).toHaveCount(0);
    expect((await vp.request.post(`/api/v1/workspaces/${owner.workspaceId}/datasets/demo`, { headers: apiHeaders })).status()).toBe(403);
    expect((await vp.request.post(`/api/v1/workspaces/${owner.workspaceId}/invitations`, { data: { email: uniqueEmail("x"), role: "viewer" }, headers: apiHeaders })).status()).toBe(403);

    // the owner sees two members; roles are shown
    await page.reload();
    await expect(page.getByTestId("member-row")).toHaveCount(2);
    await expect(page.getByTestId("invitation-row")).toHaveCount(0);
    await ctx.close();
  });

  test("an invitation cannot be accepted by a different email address", async ({ page, browser }) => {
    const owner = await createAccount("Owen Owner");
    await signIn(page, owner);
    const invitee = uniqueEmail("invitee");
    await post(page, `/workspaces/${owner.workspaceId}/invitations`, { email: invitee, role: "analyst" });
    const link = linkIn(await waitForMail(invitee, /invited you/i));
    const token = new URL(link).searchParams.get("token")!;
    const other = await createAccount("Other Person");
    const ctx = await browser.newContext();
    const op = await ctx.newPage();
    await signIn(op, other);
    const r = await op.request.post("/api/v1/invitations/accept", { data: { token }, headers: apiHeaders });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    expect(r.status()).toBeLessThan(500);
    await ctx.close();
  });
});
