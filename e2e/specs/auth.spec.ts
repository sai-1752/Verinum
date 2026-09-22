import { expect, test } from "@playwright/test";
import { PASSWORD, createAccount, linkIn, registerViaUi, signIn, uniqueEmail, waitForMail, watchConsole } from "../support";

test.describe("accounts and sessions", () => {
  test("AC1 · a person can create an account and lands in their own workspace", async ({ page }) => {
    const problems = watchConsole(page);
    const a = await registerViaUi(page, { name: "Sai Tester" });
    await expect(page.getByRole("heading", { name: "Datasets", level: 1 })).toBeVisible();
    await expect(page.getByText("Drop a spreadsheet here")).toBeVisible();
    await expect(page.getByRole("button", { name: /Sai's workspace/ })).toBeVisible();
    expect(page.url()).toContain(`/w/${a.workspaceId}`);
    expect(problems()).toEqual([]);
  });

  test("AC2 · the session cookie is HttpOnly and survives a reload; sign-out ends the session", async ({ page, context }) => {
    await registerViaUi(page);
    const cookie = (await context.cookies()).find((c) => c.name === "vn_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Datasets", level: 1 })).toBeVisible();
    await page.goto("/account");
    await page.getByRole("button", { name: "Sign out" }).last().click();
    await page.waitForURL(/\/(login)?$/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);
  });

  test("AC3 · wrong credentials are refused with one message, right ones sign in", async ({ page }) => {
    const a = await createAccount();
    await page.goto("/login");
    await page.getByLabel("Email").fill(a.email);
    await page.getByLabel("Password").fill("not-the-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    const wrong = await page.getByRole("alert").innerText();
    await page.getByLabel("Email").fill(uniqueEmail("nobody"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText(wrong); // unknown email and wrong password look the same
    await page.getByLabel("Email").fill(a.email);
    await page.getByLabel("Password").fill(a.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/w\//);
  });

  test("AC4 · email verification works from the emailed link", async ({ page }) => {
    const a = await registerViaUi(page);
    await expect(page.getByText("Please confirm your email address.")).toBeVisible();
    const mail = await waitForMail(a.email, /verify your email/i);
    await page.goto(linkIn(mail));
    await expect(page.getByText("Email confirmed")).toBeVisible();
    await page.goto(`/w/${a.workspaceId}`);
    await expect(page.getByText("Please confirm your email address.")).toHaveCount(0);
  });

  test("AC5 · a forgotten password can be reset from the emailed link, once", async ({ page }) => {
    const a = await createAccount();
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(a.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    const link = linkIn(await waitForMail(a.email, /reset your/i));
    await page.goto(link);
    await page.getByLabel("New password").fill("A-brand-new-passphrase-42");
    await page.getByRole("button", { name: "Update password" }).click();
    await page.goto("/login");
    await page.getByLabel("Email").fill(a.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible(); // the old password no longer works
    await page.getByLabel("Password").fill("A-brand-new-passphrase-42");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/w\//);
    // the link is single-use
    await page.goto(link);
    await page.getByLabel("New password").fill("Another-passphrase-77-x");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("signed-out visitors are sent to sign in and back to where they were going", async ({ page }) => {
    await page.goto("/w/00000000-0000-0000-0000-000000000000/datasets");
    await expect(page).toHaveURL(/\/login\?next=%2Fw%2F0{8}/);
  });

  test("signing in with an existing session cookie set through the API works without the UI", async ({ page }) => {
    const a = await createAccount();
    await signIn(page, a);
    await page.goto(`/w/${a.workspaceId}`);
    await expect(page.getByRole("heading", { name: "Datasets", level: 1 })).toBeVisible();
  });
});
