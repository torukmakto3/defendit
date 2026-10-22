import { expect, type Page, type Route } from "@playwright/test";
import path from "path";

export const ANSWER =
  "The recommendation rests on churn near 1.2% and LTV/CAC above 3 because if churn doubled, IRR falls first and the round should shrink.";

export const PLANTED_ANSWER =
  "That excerpt was altered and does not match the unit economics section. The figure is wrong.";

const fixture = path.join(process.cwd(), "fixtures", "sample-memo.md");

/** Refuse anything that is not the local app, so a test cannot call a paid model host. */
export async function blockExternal(page: Page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return route.continue();
    }
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return route.continue();
    return route.abort("blockedbyclient");
  });
}

export async function signIn(page: Page, email: string) {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await page.getByRole("link", { name: "Open sign-in link (dev mode)" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.locator("#difficulty")).toBeVisible();
}

export async function uploadDeliverable(page: Page, difficulty: "standard" | "hard") {
  await page.locator("#difficulty").selectOption(difficulty);
  await expect(page.locator("#difficulty")).toHaveValue(difficulty);
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByRole("button", { name: "Defend now" })).toBeVisible();
}

/** Upload on a claimed defense link, then wait until the interview can start. */
export async function uploadOnDefenseLink(page: Page) {
  await expect(page.getByRole("button", { name: "Upload" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("link", { name: "Start Defend interview" })).toBeVisible();
}

export async function openDefend(page: Page) {
  await page.getByRole("button", { name: "Defend now" }).click();
  await page.waitForURL(/\/d\/[^/]+\/defend$/);
}

export function questionHeading(page: Page, n: number) {
  return page.getByText(new RegExp(`Question ${n} /`));
}

export async function expectQuestion(page: Page, n: number) {
  await expect(questionHeading(page, n)).toBeVisible();
  await expect(page.locator("textarea")).toBeEnabled();
}

export async function currentQuestion(page: Page) {
  return page.locator(".panel p.whitespace-pre-wrap").innerText();
}

export async function fillVisibleAnswer(page: Page) {
  const label = (await page.locator(".panel p.mono").first().innerText()).toLowerCase();
  const field = page.locator("textarea");
  await expect(field).toBeEnabled();
  const text = label.includes("planted") ? PLANTED_ANSWER : ANSWER;
  await field.fill(text);
  await expect(field).toHaveValue(text);
}

export async function answerVisibleQuestion(page: Page) {
  await fillVisibleAnswer(page);
  await page.getByRole("button", { name: /Submit & (next|finish)/ }).click();
}

async function leftQuestion(page: Page, previousQuestion: string) {
  if (/\/r\/rcpt_/.test(page.url())) return true;
  if (await page.getByText("Signature valid").isVisible()) return true;
  if (await page.getByRole("link", { name: "Open your receipt" }).isVisible()) return true;
  if (
    await page
      .getByText(/of \d graders done|Grading council scoring|Combining the council|Signing the receipt|Retry grading/)
      .isVisible()
  ) {
    return true;
  }
  const prompt = page.locator(".panel p.whitespace-pre-wrap");
  if (!(await prompt.isVisible())) return false;
  return (await prompt.innerText()) !== previousQuestion;
}

/** Answer until the receipt is on screen, including a grader follow-up if one appears. */
export async function defendToReceipt(page: Page) {
  for (let step = 0; step < 10; step++) {
    if (await openReceipt(page)) return;
    const signature = page.getByText("Signature valid");
    const submit = page.getByRole("button", { name: /Submit & (next|finish)/ });
    const receiptLink = page.getByRole("link", { name: "Open your receipt" });
    await expect(signature.or(submit).or(receiptLink)).toBeVisible({ timeout: 25_000 });
    if (await openReceipt(page)) return;
    const previous = await currentQuestion(page);
    await answerVisibleQuestion(page);
    await expect.poll(() => leftQuestion(page, previous), { timeout: 25_000 }).toBe(true);
  }
  await expect(page.getByText("Signature valid")).toBeVisible({ timeout: 25_000 });
}

/** A finished challenge stops on the publish choice, which links to the signed receipt. */
async function openReceipt(page: Page): Promise<boolean> {
  if (/\/r\/rcpt_/.test(page.url()) && (await page.getByText("Signature valid").isVisible())) return true;
  const receiptLink = page.getByRole("link", { name: "Open your receipt" });
  if (!(await receiptLink.isVisible())) return false;
  await receiptLink.click();
  await page.waitForURL(/\/r\/rcpt_/);
  await expect(page.getByText("Signature valid")).toBeVisible();
  return true;
}

/**
 * Answer every question except the last, then fill that answer without submitting.
 * The caller clicks Submit & finish so it can install a fault first.
 */
export async function answerUntilLast(page: Page) {
  for (let step = 0; step < 8; step++) {
    const finish = page.getByRole("button", { name: "Submit & finish" });
    const next = page.getByRole("button", { name: "Submit & next" });
    await expect(finish.or(next)).toBeEnabled({ timeout: 20_000 });
    if (await finish.isVisible()) {
      await fillVisibleAnswer(page);
      return;
    }
    const previous = await currentQuestion(page);
    await answerVisibleQuestion(page);
    await expect.poll(() => leftQuestion(page, previous), { timeout: 20_000 }).toBe(true);
  }
  throw new Error("interview did not reach the last question");
}

export function countPosts(page: Page, path: string) {
  let n = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes(path)) n += 1;
  });
  return () => n;
}

/** First matching POST is fulfilled by `fault`; later ones hit the app. */
export async function failFirstPost(page: Page, path: string, fault: (route: Route) => Promise<void>) {
  let armed = true;
  await page.route(`**${path}`, async (route) => {
    if (!armed || route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    armed = false;
    await fault(route);
  });
}
