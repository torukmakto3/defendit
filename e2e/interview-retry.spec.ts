import { expect, test, type Page } from "@playwright/test";
import {
  ANSWER,
  answerUntilLast,
  answerVisibleQuestion,
  blockExternal,
  countPosts,
  currentQuestion,
  defendToReceipt,
  expectQuestion,
  failFirstPost,
  openDefend,
  signIn,
  uploadDeliverable,
  uploadOnDefenseLink,
} from "./interview";

function email(label: string) {
  return `e2e-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@fund.example`;
}

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
});

test("text interview reaches a signed receipt and shows the council working", async ({ page }) => {
  await signIn(page, email("happy"));
  await uploadDeliverable(page, "standard");
  await openDefend(page);
  await expectQuestion(page, 1);
  await answerUntilLast(page);
  await page.getByRole("button", { name: "Submit & finish" }).click();
  await expect(page.getByText(/\d of 3 graders done/)).toBeVisible();
  await defendToReceipt(page);
  await expect(page).toHaveURL(/\/r\/rcpt_/);
});

test("a failed question fetch can be retried", async ({ page }) => {
  await signIn(page, email("fetch"));
  await uploadDeliverable(page, "standard");
  await failFirstPost(page, "/api/sessions/start", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Failed to start" }),
    });
  });
  await openDefend(page);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("Failed to start")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expectQuestion(page, 1);
  await answerVisibleQuestion(page);
  await expectQuestion(page, 2);
});

test("a dropped answer submit retries once and does not store a duplicate", async ({ page }) => {
  await signIn(page, email("drop"));
  await uploadDeliverable(page, "standard");
  await openDefend(page);
  await expectQuestion(page, 1);
  await failFirstPost(page, "/api/sessions/defend/answer", async (route) => {
    await route.fetch();
    await route.abort("timedout");
  });
  await page.locator("textarea").fill(ANSWER);
  await page.getByRole("button", { name: "Submit & next" }).click();
  await expect(page.getByText(/Failed to fetch|timed out|network|aborted|Something went wrong/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit & next" })).toBeEnabled();

  const retry = page.waitForResponse(
    (res) => res.url().includes("/api/sessions/defend/answer") && res.request().method() === "POST" && res.ok(),
  );
  await page.getByRole("button", { name: "Submit & next" }).click();
  const body = (await (await retry).json()) as { answered?: number; idempotent?: boolean };
  expect(body).toMatchObject({ answered: 1, idempotent: true });
  await expectQuestion(page, 2);
  await defendToReceipt(page);
});

test("a different resubmit returns 409 and the original answer still continues", async ({ page }) => {
  await signIn(page, email("dup"));
  await uploadDeliverable(page, "standard");
  await openDefend(page);
  await expectQuestion(page, 1);
  await failFirstPost(page, "/api/sessions/defend/answer", async (route) => {
    await route.fetch();
    await route.abort("timedout");
  });
  await page.locator("textarea").fill(ANSWER);
  await page.getByRole("button", { name: "Submit & next" }).click();
  await expect(page.getByRole("button", { name: "Submit & next" })).toBeEnabled();

  await page.locator("textarea").fill("A different answer that was not the one already stored.");
  const denied = page.waitForResponse(
    (res) => res.url().includes("/api/sessions/defend/answer") && res.request().method() === "POST" && res.status() === 409,
  );
  await page.getByRole("button", { name: "Submit & next" }).click();
  const deniedBody = (await (await denied).json()) as { error?: string };
  expect(deniedBody.error).toMatch(/already answered/i);
  await expect(page.getByText(/already answered/i)).toBeVisible();
  await expectQuestion(page, 1);

  await page.locator("textarea").fill(ANSWER);
  const saved = page.waitForResponse(
    (res) => res.url().includes("/api/sessions/defend/answer") && res.request().method() === "POST" && res.ok(),
  );
  await page.getByRole("button", { name: "Submit & next" }).click();
  expect(await (await saved).json()).toMatchObject({ answered: 1, idempotent: true });
  await expectQuestion(page, 2);
  await defendToReceipt(page);
});

test("a failed grade can be retried into a signed receipt", async ({ page }) => {
  await reachFinish(page, "grade");
  await failFirstPost(page, "/api/sessions/defend/complete", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Grading failed" }),
    });
  });
  await page.getByRole("button", { name: "Submit & finish" }).click();
  await expect(page.getByRole("button", { name: "Retry grading" })).toBeVisible();
  await expect(page.getByText("Grading failed")).toBeVisible();
  await page.getByRole("button", { name: "Retry grading" }).click();
  await defendToReceipt(page);
});

test("a reload mid-interview resumes the same session on the open question", async ({ page }) => {
  const starts = countPosts(page, "/api/sessions/start");
  await signIn(page, email("reload"));
  await uploadDeliverable(page, "standard");
  await openDefend(page);
  await expectQuestion(page, 1);
  await answerVisibleQuestion(page);
  await expectQuestion(page, 2);
  const question = await currentQuestion(page);
  expect(starts()).toBe(1);
  const before = (await page.evaluate(async () => {
    const token = window.location.pathname.split("/")[2] ?? "";
    const res = await fetch(`/api/sessions/defend/state?token=${encodeURIComponent(token)}`);
    return res.json();
  })) as { sessionId?: string; answered?: number };
  expect(before.sessionId).toMatch(/^ses_/);
  expect(before.answered).toBe(1);
  const holds = await defenseHoldIds(page);
  expect(holds).toHaveLength(1);

  const stateWait = page.waitForResponse(
    (res) => res.url().includes("/api/sessions/defend/state") && res.request().method() === "GET" && res.ok(),
  );
  await page.reload();
  const state = (await (await stateWait).json()) as { sessionId?: string; answered?: number };
  expect(state.sessionId).toBe(before.sessionId);
  expect(state.answered).toBe(1);
  expect(await defenseHoldIds(page)).toEqual(holds);
  await expectQuestion(page, 2);
  expect(await currentQuestion(page)).toBe(question);
  expect(starts()).toBe(1);
  await defendToReceipt(page);
});

test("a reload after every answer is stored resumes grading into a receipt", async ({ page }) => {
  await reachFinish(page, "resume-grade");
  await failFirstPost(page, "/api/sessions/defend/complete", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Grading failed" }),
    });
  });
  await page.getByRole("button", { name: "Submit & finish" }).click();
  await expect(page.getByRole("button", { name: "Retry grading" })).toBeVisible();
  await page.reload();
  await defendToReceipt(page);
  await expect(page).toHaveURL(/\/r\/rcpt_/);
});

test("a streamed start that errors recovers onto the session it created", async ({ page }) => {
  const starts = countPosts(page, "/api/sessions/start");
  await signIn(page, email("stream"));
  await uploadDeliverable(page, "standard");
  await failFirstPost(page, "/api/sessions/start", async (route) => {
    await route.fetch();
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "error", error: "Could not phrase the first question" })}\n`,
    });
  });
  await openDefend(page);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("Could not phrase the first question")).toBeVisible();
  expect(starts()).toBe(1);
  await page.getByRole("button", { name: "Try again" }).click();
  await expectQuestion(page, 1);
  expect(starts()).toBe(1);
  await answerVisibleQuestion(page);
  await expectQuestion(page, 2);
});

test("a start stream that dies after the first question still advances", async ({ page }) => {
  await signIn(page, email("cut"));
  await uploadDeliverable(page, "standard");
  await failFirstPost(page, "/api/sessions/start", async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    const first = text.split("\n").find((line) => line.trim()) ?? "";
    const event = JSON.parse(first) as { type?: string };
    expect(event.type).toBe("question");
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${first}\n`,
    });
  });
  await openDefend(page);
  await expectQuestion(page, 1);
  await answerVisibleQuestion(page);
  await expectQuestion(page, 2);
});

test("a voice error falls back to a typed interview and a signed receipt", async ({ page }) => {
  await signIn(page, email("voice"));
  await uploadDeliverable(page, "hard");
  await openDefend(page);
  await page.getByRole("button", { name: "Start voice interview" }).click();
  await expect(page.getByText("Voice interviews are not configured.")).toBeVisible();
  const started = page.waitForResponse(
    (res) => res.url().includes("/api/sessions/start") && res.request().method() === "POST" && res.ok(),
  );
  await page.getByRole("button", { name: "Answer in writing instead" }).click();
  await started;
  await expect(page.getByText("typed (accommodation)")).toBeVisible();
  await expectQuestion(page, 1);
  await defendToReceipt(page);
});

test("a challenge defense is claimed, uploaded, defended, and receipted", async ({ browser, baseURL }) => {
  const challengerContext = await browser.newContext({ baseURL });
  const defenderContext = await browser.newContext({ baseURL });
  const challenger = await challengerContext.newPage();
  const defender = await defenderContext.newPage();
  try {
    await blockExternal(challenger);
    await blockExternal(defender);
    await signIn(challenger, email("challenger"));
    await challenger.goto("/c/new");
    await challenger.getByLabel("What should they defend?").fill("Defend the sample memo's unit economics.");
    await challenger.locator("#difficulty").selectOption("standard");
    await challenger.getByRole("button", { name: "Create challenge link" }).click();
    const link = (await challenger.locator("p.font-mono").innerText()).trim();
    expect(link).toMatch(/\/c\/[a-z0-9]+/);

    await signIn(defender, email("defender"));
    await defender.goto(link);
    await defender.getByRole("checkbox", { name: /18 or older/ }).check();
    await defender.getByRole("button", { name: "Accept challenge" }).click();
    await defender.waitForURL(/\/d\/[^/]+$/);
    await uploadOnDefenseLink(defender);
    await defender.getByRole("link", { name: "Start Defend interview" }).click();
    await defender.waitForURL(/\/d\/[^/]+\/defend$/);
    await expectQuestion(defender, 1);
    await defendToReceipt(defender);
    await expect(defender).toHaveURL(/\/r\/rcpt_/);
  } finally {
    await challengerContext.close();
    await defenderContext.close();
  }
});

test("a spent beta allowance shows the out-of-credits screen", async ({ page }) => {
  await signIn(page, email("empty"));
  await uploadDeliverable(page, "standard");
  await openDefend(page);
  await defendToReceipt(page);

  await page.goto("/");
  await uploadDeliverable(page, "standard");
  const denied = page.waitForResponse(
    (res) => res.url().includes("/api/sessions/start") && res.request().method() === "POST" && res.status() === 402,
  );
  await openDefend(page);
  const body = (await (await denied).json()) as { error?: string };
  expect(body.error).toMatch(/free beta defense/i);
  await expect(page.getByText(/You've used your \d+ free beta defense/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText(/Question 1 \//)).toHaveCount(0);
});

async function defenseHoldIds(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/dashboard");
  expect(res.ok()).toBeTruthy();
  const data = (await res.json()) as {
    wallet?: { history?: { id: string; label: string; amount: number }[] };
  };
  return (data.wallet?.history ?? [])
    .filter((row) => row.label.startsWith("Hold for defense") && row.amount < 0)
    .map((row) => row.id)
    .sort();
}

async function reachFinish(page: Page, label: string) {
  await signIn(page, email(label));
  await uploadDeliverable(page, "standard");
  await openDefend(page);
  await expectQuestion(page, 1);
  await answerUntilLast(page);
}
