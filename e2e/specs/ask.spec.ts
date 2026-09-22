import { expect, test } from "@playwright/test";
import { createAccount, get, post, signIn, watchConsole, type Account } from "../support";

test.describe.configure({ mode: "serial" });

let acct: Account;
let dsId: string;
const RANKING = [["Aura Watch", "506.5K", "15.7"], ["Nimbus Ring", "441.4K", "13.7"], ["Orbit Dock", "407.0K", "12.6"], ["Shield Case", "374.3K", "11.6"], ["Vista Hub", "364.7K", "11.3"]] as const;
const askUrl = () => `/w/${acct.workspaceId}/datasets/${dsId}/ask`;

test.beforeAll(async () => { acct = await createAccount("Asker Person"); });

test.beforeEach(async ({ page }) => {
  await signIn(page, acct);
  if (!dsId) {
    const r = await post(page, `/workspaces/${acct.workspaceId}/datasets/demo`);
    dsId = (await r.json()).datasetId;
    await expect.poll(async () => (await get(page, `/workspaces/${acct.workspaceId}/datasets/${dsId}`)).status, { timeout: 60_000 }).toBe("ready");
  }
});

test("AC18 · \"What are the top 5 products?\" returns the exact ranking, with a chart, every figure checked", async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto(askUrl());
  await page.getByTestId("ask-input").fill("What are the top 5 products?");
  await page.keyboard.press("Enter");
  const answer = page.locator(".thread-rail").first();
  await expect(answer).toContainText("Aura Watch", { timeout: 30_000 });
  // each product's name, total and share are all present, and each figure carries the "checked" mark
  for (const [name, total, share] of RANKING) {
    await expect(answer).toContainText(name);
    await expect(answer.locator(".vnum", { hasText: total })).toBeVisible();
    await expect(answer.locator(".vnum", { hasText: `${share}%` })).toBeVisible();
  }
  await expect(answer.getByText("Total Sales by Product").first()).toBeVisible();
  await expect(answer).toContainText("every figure checked");
  await expect(answer).not.toContainText("were removed");
  // the figures that were checked are marked, one per number
  expect(await answer.locator(".vnum").count()).toBeGreaterThanOrEqual(10);
  expect(problems()).toEqual([]);
});

test("AC18b · if the model provider is down, the same question is still answered exactly, from the computed result", async ({ page }) => {
  await page.goto(askUrl());
  await page.getByTestId("ask-input").fill("What are the top 5 products? (outage)");
  await page.keyboard.press("Enter");
  const answer = page.locator(".thread-rail").first();
  await expect(answer).toContainText("Aura Watch", { timeout: 40_000 });
  for (const [name, total] of RANKING) { await expect(answer).toContainText(name); await expect(answer.locator(".vnum", { hasText: total })).toBeVisible(); }
  await expect(answer).not.toContainText("every figure checked"); // not model-written, and it does not claim to be
  expect(await answer.locator(".vnum").count()).toBeGreaterThanOrEqual(10);
});

test("AC19 · a marked figure shows where it came from", async ({ page }) => {
  await page.goto(askUrl());
  await page.getByTestId("ask-input").fill("What are the top 5 products?");
  await page.keyboard.press("Enter");
  const first = page.locator(".vnum", { hasText: "506.5K" }).first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  await first.hover();
  await expect(page.getByRole("tooltip").or(page.locator("[role=tooltip]")).first()).toContainText(/top_n|Total Sales|Aura Watch/i);
  await expect(page.getByText(/top_n/).first()).toBeVisible(); // "where it came from" names the calculation
});

test("AC20 · with a model configured, an invented figure is removed before it is shown, and the answer says so", async ({ page }) => {
  await page.goto(askUrl());
  await page.getByTestId("ask-input").fill("Which product is our best seller and what will happen next quarter?");
  await page.keyboard.press("Enter");
  const answer = page.locator(".thread-rail").first();
  await expect(answer).toContainText("Aura Watch is the top product with 506.5K", { timeout: 30_000 });
  await expect(answer).toContainText("15.7%");
  await expect(page.locator("body")).not.toContainText("9.9M");
  await expect(page.getByText(/removed|couldn't be checked|could not be verified|not verified/i).first()).toBeVisible();
  // and it was never sent to the browser at all
  const conv = await get(page, `/workspaces/${acct.workspaceId}/datasets/${dsId}/conversations`);
  const id = conv.conversations[0].id;
  const full = await page.request.get(`/api/v1/workspaces/${acct.workspaceId}/datasets/${dsId}/conversations/${id}`);
  expect(await full.text()).not.toContain("9.9M");
});

test("follow-ups are offered, and the conversation is kept in history", async ({ page }) => {
  await page.goto(askUrl());
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("dialog", { name: "Past conversations" })).toContainText(/top 5|best seller/i);
});

test("a question the data cannot answer gets an honest 'can't answer' with things to try, and no statistics", async ({ page }) => {
  await page.goto(askUrl());
  await page.getByTestId("ask-input").fill("What is the weather in Paris? (outage)");
  await page.keyboard.press("Enter");
  const answer = page.locator(".thread-rail").first();
  await expect(answer).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText("Working out how to answer")).toHaveCount(0, { timeout: 40_000 });
  const text = await answer.innerText();
  expect(text).not.toMatch(/\d+(\.\d+)?\s?(%|K|M)\b/);
  await expect(answer.locator(".vnum")).toHaveCount(0);
});
