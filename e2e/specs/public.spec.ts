import { expect, test } from "@playwright/test";
import { watchConsole } from "../support";

test.describe("public pages", () => {
  test("the landing page explains the product, shows a real specimen answer, and has SEO essentials", async ({ page }) => {
    const problems = watchConsole(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("can't make up numbers");
    await expect(page).toHaveTitle(/Verinum/);
    expect(await page.locator('meta[name="description"]').getAttribute("content")).toMatch(/spreadsheet/i);
    expect(await page.locator('link[rel="canonical"]').count()).toBe(1);
    expect(await page.locator('script[type="application/ld+json"]').count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole("listitem").filter({ hasText: /Aura Watch\s*[–—-]\s*506\.5K/ })).toBeVisible(); // the specimen is real output from the demo data
    await page.getByRole("link", { name: "Pricing" }).first().click();
    await expect(page.getByTestId("plan-free")).toBeVisible();
    await page.getByRole("link", { name: "How it works" }).first().click();
    await expect(page).toHaveURL(/how-it-works/);
    expect(problems()).toEqual([]);
  });

  test("the FAQ opens and closes from the keyboard", async ({ page }) => {
    await page.goto("/");
    const item = page.locator("details", { hasText: "Can it still be wrong?" });
    await item.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(item).toHaveJSProperty("open", true);
    await page.keyboard.press("Enter");
    await expect(item).toHaveJSProperty("open", false);
  });

  test("an unknown address shows a helpful not-found page", async ({ page }) => {
    await page.goto("/definitely/not/here");
    await expect(page.getByRole("heading").first()).toContainText(/not found|can't find|doesn't exist/i);
  });

  test("the API hides internals: health is open, metrics need a token, unknown routes are JSON 404s", async ({ request }) => {
    expect((await request.get("/api/v1/auth/config")).status()).toBe(200);
    const nf = await request.get("/api/v1/nope");
    expect(nf.status()).toBe(404);
    expect(nf.headers()["content-type"]).toContain("application/json");
    expect((await request.get("http://127.0.0.1:4600/healthz")).status()).toBe(200);
    expect((await request.get("http://127.0.0.1:4600/metrics")).status()).toBe(403); // metrics need the bearer token
    const metrics = await request.get("http://127.0.0.1:4600/metrics", { headers: { authorization: "Bearer e2e-metrics-token" } });
    expect(metrics.status()).toBe(200);
    expect(await metrics.text()).toContain("http_requests_total");
  });
});
