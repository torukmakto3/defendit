import { expect, test } from "@playwright/test";
import { answerVisibleQuestion, blockExternal, countPosts, currentQuestion, expectQuestion } from "./interview";

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
});

test("a sample demo reload resumes the same interview", async ({ page }) => {
  const starts = countPosts(page, "/api/sessions/start");
  await page.goto("/");
  await page.getByRole("button", { name: "Try it with a sample file" }).click();
  await page.waitForURL(/\/d\/[^/]+\/defend$/);
  await expect(page.getByRole("heading", { name: "Sample defense" })).toBeVisible();
  await expectQuestion(page, 1);
  await answerVisibleQuestion(page);
  await expectQuestion(page, 2);
  const question = await currentQuestion(page);
  expect(starts()).toBe(1);

  const stateWait = page.waitForResponse(
    (res) => res.url().includes("/api/sessions/defend/state") && res.request().method() === "GET" && res.ok(),
  );
  await page.reload();
  const state = (await (await stateWait).json()) as { sessionId?: string; answered?: number; demo?: boolean };
  expect(state.sessionId).toMatch(/^ses_/);
  expect(state.answered).toBe(1);
  expect(state.demo).toBe(true);
  await expect(page.getByRole("heading", { name: "Sample defense" })).toBeVisible();
  await expectQuestion(page, 2);
  expect(await currentQuestion(page)).toBe(question);
  expect(starts()).toBe(1);
});
