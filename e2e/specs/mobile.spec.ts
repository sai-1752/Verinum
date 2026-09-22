import { expect, test } from "@playwright/test";
import { createAccount, get, post, signIn } from "../support";

const noHorizontalScroll = async (page: import("@playwright/test").Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test("the app is usable at phone width: no horizontal page scroll, navigation reachable", async ({ page }) => {
  await page.goto("/");
  await noHorizontalScroll(page);
  const a = await createAccount("Phone Person");
  await signIn(page, a);
  const d = await (await post(page, `/workspaces/${a.workspaceId}/datasets/demo`)).json();
  await expect.poll(async () => (await get(page, `/workspaces/${a.workspaceId}/datasets/${d.datasetId}`)).status, { timeout: 60_000 }).toBe("ready");
  for (const tab of ["overview", "insights", "dashboard", "forecast", "explore", "data", "ask"]) {
    await page.goto(`/w/${a.workspaceId}/datasets/${d.datasetId}/${tab}`);
    await expect(page.getByTestId("dataset-title")).toBeVisible();
    await page.waitForTimeout(500);
    await noHorizontalScroll(page);
  }
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("link", { name: "Members" })).toBeVisible();
});
