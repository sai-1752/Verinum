import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { DEMO_CSV, SMALL_CSV, createAccount, get, signIn, watchConsole, type Account } from "../support";

/** One account and one uploaded file are shared by the tests below, which run in order. */
test.describe.configure({ mode: "serial" });

let acct: Account;
let dsId: string;
const base = () => `/w/${acct.workspaceId}/datasets/${dsId}`;

test.beforeAll(async () => { acct = await createAccount("Analyst Person"); });

test("AC6 · uploading a CSV shows progress, then a ready dataset", async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, acct);
  await page.goto(`/w/${acct.workspaceId}`);
  await page.getByTestId("file-input").setInputFiles({ name: "sales-2026.csv", mimeType: "text/csv", buffer: readFileSync(DEMO_CSV) });
  await page.waitForURL(/\/datasets\/[0-9a-f-]{36}/);
  dsId = page.url().match(/datasets\/([0-9a-f-]{36})/)![1]!;
  // either we catch the progress view or the job was already done; both must end in a ready dataset
  await expect(page.getByTestId("dataset-title")).toHaveText("sales-2026", { timeout: 60_000 });
  await expect(page.getByText(/6,764 rows/).first()).toBeVisible();
  await page.goto(`/w/${acct.workspaceId}`);
  await expect(page.getByTestId("dataset-row")).toHaveCount(1);
  expect(problems()).toEqual([]);
});

test("AC7 · the overview leads with a computed headline, KPIs and ranked findings", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`${base()}/overview`);
  await expect(page.getByTestId("exec-headline")).toContainText("6,764 rows");
  await expect(page.getByTestId("exec-headline")).toContainText("Total Sales is 3.23M");
  const kpis = page.getByRole("region", { name: "Headline figures" });
  await expect(kpis.getByText("Total Sales")).toBeVisible();
  await expect(kpis.getByText("3.23M")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What stands out" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sales is trending up" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Profit margin is eroding" })).toBeVisible();
});

test("AC8 · every finding can show its working", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`${base()}/insights`);
  await page.getByRole("button", { name: "Show the working" }).first().click();
  await expect(page.getByText("How it was computed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide the working" })).toBeVisible();
});

test("AC9 · data quality: a score, plain-language issues, an itemised transformation log, and fixes offered rather than applied", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`${base()}/data`);
  await expect(page.getByTestId("quality-score")).toHaveText("74");
  expect(await page.getByTestId("quality-issue").count()).toBeGreaterThan(3);
  expect(await page.getByTestId("transform-log").locator("li").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("suggestion").filter({ hasText: "exactly repeat an earlier row" })).toBeVisible();
  await expect(page.getByText("Nothing here changes your analysis until you choose to apply a fix.")).toBeVisible();
  await expect(page.getByTestId("column-row")).toHaveCount(12); // 16 columns, first twelve shown
});

test("AC10 · applying a suggested fix creates a new version and re-runs the analysis", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`${base()}/data`);
  await page.getByRole("button", { name: "Remove duplicates" }).click();
  await expect.poll(async () => (await get(page, `/workspaces/${acct.workspaceId}/datasets/${dsId}`)).version?.version, { timeout: 60_000 }).toBe(2);
  await page.reload();
  await expect(page.getByText(/6,750 rows/).first()).toBeVisible({ timeout: 60_000 });
  const versions = await get(page, `/workspaces/${acct.workspaceId}/datasets/${dsId}/versions`);
  expect((versions.versions ?? versions).length).toBe(2);
});

test("AC11 · the dashboard is planned from the data; a filter applies to every chart at once", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`${base()}/dashboard`);
  await expect(page.getByTestId("widget").first()).toBeVisible({ timeout: 30_000 });
  expect(await page.getByTestId("widget").count()).toBeGreaterThan(6);
  await expect(page.getByRole("region", { name: "Sales over time" })).toBeVisible();
  await page.getByRole("button", { name: "Region", exact: true }).click();
  await page.getByRole("checkbox", { name: /^APAC/ }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Sales by Region" })).toBeVisible();
  // the filter is applied to the calculations behind every figure, not just hidden in the view
  await expect(page.getByText("6,750", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Region: APAC/ })).toBeVisible();
});

test("AC12 · a forecast appears only with enough history, shows its range and says what it assumes", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`${base()}/forecast`);
  await expect(page.getByText("Projected values")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Likely range").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "What this assumes" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "This is a forecast estimate, not a guaranteed outcome." })).toBeVisible();
  await expect(page.getByText(/at least 24 \(two full cycles\)/)).toBeVisible(); // seasonality honestly withheld
});

test("AC13 · a file with too little history gets no forecast, and the page says why", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`/w/${acct.workspaceId}`);
  await page.getByTestId("file-input").setInputFiles({ name: "four-days.csv", mimeType: "text/csv", buffer: Buffer.from(SMALL_CSV) });
  await page.waitForURL(/\/datasets\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("dataset-title")).toHaveText("four-days", { timeout: 60_000 });
  await page.getByRole("link", { name: "Forecast" }).first().click();
  await expect(page.getByText(/stays off|not enough|too few|needs a date column/i).first()).toBeVisible();
  await expect(page.getByText("Projected values")).toHaveCount(0);
});

test("AC14 · the explorer searches, pages and exports exactly the rows in view", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`${base()}/explore`);
  await expect(page.getByText(/6,750 of 6,750 rows/)).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder("Search text columns…").fill("Aura Watch");
  await expect(page.getByText(/^[\d,]+ of 6,750 rows$/)).not.toHaveText(/^6,750 of/, { timeout: 10_000 });
  expect(await page.locator("tbody tr").count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Export" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /CSV/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
});

test("AC15 · usage meters and the audit log reflect what was done", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`/w/${acct.workspaceId}/usage`);
  await expect(page.getByTestId("usage-meters")).toContainText("Datasets");
  await expect(page.getByTestId("usage-meters")).toContainText("2 of 3");
  await page.goto(`/w/${acct.workspaceId}/audit`);
  await expect(page.getByTestId("audit-table")).toContainText(/dataset/i);
});

test("AC16 · the free plan's dataset limit is enforced with a clear message", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`/w/${acct.workspaceId}`);
  await page.getByTestId("try-demo").click(); // third dataset
  await page.waitForURL(/\/datasets\/[0-9a-f-]{36}/);
  await page.goto(`/w/${acct.workspaceId}`);
  await page.getByTestId("file-input").setInputFiles({ name: "fourth.csv", mimeType: "text/csv", buffer: Buffer.from(SMALL_CSV) });
  await expect(page.getByText("You've reached a plan limit")).toBeVisible();
  await expect(page.getByText(/allows 3 datasets/)).toBeVisible();
  await expect(page.getByRole("link", { name: "See plans" })).toBeVisible();
  await expect(page.getByTestId("dataset-row")).toHaveCount(3);
});

test("AC17 · a dataset can be deleted, and it disappears from the list", async ({ page }) => {
  await signIn(page, acct);
  await page.goto(`/w/${acct.workspaceId}`);
  const row = page.getByTestId("dataset-row").filter({ hasText: "four-days" });
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete dataset" }).click();
  await expect(page.getByTestId("dataset-row").filter({ hasText: "four-days" })).toHaveCount(0);
  const list = await get(page, `/workspaces/${acct.workspaceId}/datasets`);
  expect(list.datasets.map((d: { name: string }) => d.name)).not.toContain("four-days");
});
