import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { getDb, resetDbForTests } from "../src/lib/db";
import { generateFlashcards } from "../src/lib/flashcards";
import { getPrimaryLlm, withLlmScope } from "../src/lib/llm";
import { createLiquidProvider } from "../src/lib/llm/openai-compat";
import {
  estimateCostUsd,
  sessionBudgetUsd,
  usageFromProviderBody,
} from "../src/lib/llm/usage";
import {
  completeDefendSession,
  creatorIngest,
  getAdminSessionDetail,
  learnCoachTurn,
  listAdminSessions,
  recordDefendAnswer,
  startSession,
} from "../src/lib/services";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));

describe("usage from a provider body", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["SESSION_BUDGET_USD", "LLM_PRICE_INPUT_PER_MTOK", "LLM_PRICE_OUTPUT_PER_MTOK"];

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("uses Liquid's settled charge and metered tokens, including reasoning", () => {
    const usage = usageFromProviderBody(
      {
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        exchange: {
          charge: { cap_usd: 0.05, estimated_usd: 0.001, total_usd: 0.000804 },
          usage: { tokens_in: 110, tokens_cached: 10, tokens_out: 20, reasoning_tokens: 5 },
        },
      },
      { promptText: "ignored", completionText: "ignored" },
    );
    expect(usage).toEqual({
      promptTokens: 110,
      completionTokens: 25,
      costUsd: 0.000804,
      costSource: "provider",
    });
  });

  it("does not treat the cap or the ranking estimate as the charge", () => {
    const usage = usageFromProviderBody(
      { exchange: { charge: { cap_usd: 0.05, estimated_usd: 9 } }, usage: { prompt_tokens: 1000, completion_tokens: 0 } },
      { promptText: "", completionText: "" },
    );
    expect(usage.costSource).toBe("estimated");
    expect(usage.costUsd).toBeCloseTo(estimateCostUsd(1000, 0));
    expect(usage.costUsd).not.toBe(0.05);
    expect(usage.costUsd).not.toBe(9);
  });

  it("accepts an OpenAI-style usage block and an OpenRouter cost", () => {
    const priced = usageFromProviderBody(
      { usage: { prompt_tokens: "12", completion_tokens: "3", cost: 0.02 } },
      { promptText: "unused", completionText: "unused" },
    );
    expect(priced).toMatchObject({ promptTokens: 12, completionTokens: 3, costUsd: 0.02, costSource: "provider" });

    const upstream = usageFromProviderBody(
      { usage: { prompt_tokens: 4, completion_tokens: 4, cost_details: { upstream_inference_cost: 0.1 } } },
      { promptText: "", completionText: "" },
    );
    expect(upstream.costSource).toBe("provider");
    expect(upstream.costUsd).toBe(0.1);
  });

  it("estimates tokens and cost when the provider omits usage", () => {
    const usage = usageFromProviderBody(null, { promptText: "abcd", completionText: "abcdefgh" });
    expect(usage).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      costUsd: estimateCostUsd(1, 2),
      costSource: "estimated",
    });
  });

  it("keeps an explicit zero charge instead of estimating", () => {
    const usage = usageFromProviderBody(
      { usage: { prompt_tokens: 8, completion_tokens: 8, cost: 0 } },
      { promptText: "abcd", completionText: "abcdefgh" },
    );
    expect(usage.costUsd).toBe(0);
    expect(usage.costSource).toBe("provider");
  });

  it("reads Anthropic token fields", () => {
    const usage = usageFromProviderBody(
      { usage: { input_tokens: 15, output_tokens: 6 } },
      { promptText: "", completionText: "" },
    );
    expect(usage.promptTokens).toBe(15);
    expect(usage.completionTokens).toBe(6);
    expect(usage.costSource).toBe("estimated");
  });

  it("uses the $3 budget unless SESSION_BUDGET_USD overrides it", () => {
    expect(sessionBudgetUsd()).toBe(3);
    process.env.SESSION_BUDGET_USD = "4.5";
    expect(sessionBudgetUsd()).toBe(4.5);
    process.env.SESSION_BUDGET_USD = "nope";
    expect(sessionBudgetUsd()).toBe(3);
  });

  it("prices an estimate from LLM_PRICE_*_PER_MTOK", () => {
    process.env.LLM_PRICE_INPUT_PER_MTOK = "1000";
    process.env.LLM_PRICE_OUTPUT_PER_MTOK = "2000";
    expect(estimateCostUsd(1_000_000, 1_000_000)).toBe(3000);
    const usage = usageFromProviderBody(
      { usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } },
      { promptText: "", completionText: "" },
    );
    expect(usage.costUsd).toBe(1000);
    expect(usage.costSource).toBe("estimated");
  });
});

describe("Liquid provider usage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies exchange usage onto the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            model: "gpt-oss-120b",
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            exchange: { charge: { total_usd: 0.5, cap_usd: 0.05 }, usage: { tokens_in: 80, tokens_out: 7 } },
          }),
          { status: 200 },
        ),
      ),
    );
    const res = await createLiquidProvider("liq_test", "gpt-oss-120b").complete({
      messages: [{ role: "user", content: "grade this" }],
      purpose: "grade",
    });
    expect(res.usage).toEqual({
      promptTokens: 80,
      completionTokens: 7,
      costUsd: 0.5,
      costSource: "provider",
    });
  });
});

describe("session totals", () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "defendit-usage-"));
    process.env.DATABASE_PATH = join(dir, "usage.db");
    delete process.env.DATABASE_URL;
    process.env.MOCK_LLM = "1";
    process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
    process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
    delete process.env.SESSION_BUDGET_USD;
    resetDbForTests();
  });

  async function signIn(email: string): Promise<User> {
    const { devLink } = await requestMagicLink({ email });
    return (await consumeMagicLink(devLink!.split("#token=")[1]))!.user;
  }

  it("adds the usage table and session columns to an existing sqlite file", async () => {
    const previous = process.env.DATABASE_PATH;
    const dir = mkdtempSync(join(tmpdir(), "defendit-migrate-"));
    const path = join(dir, "old.db");
    const raw = new Database(path);
    // A database from before this change: sessions exist, usage columns and llm_calls do not.
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        mode TEXT NOT NULL,
        purge_after TEXT
      );
      INSERT INTO sessions (id, request_id, mode, purge_after) VALUES ('ses_old', 'req_old', 'defend', '2099-01-01T00:00:00.000Z');
    `);
    raw.close();

    try {
      process.env.DATABASE_PATH = path;
      resetDbForTests();
      const db = await getDb();
      const cols = await db.all<{ name: string }>("PRAGMA table_info(sessions)");
      expect(cols.map((col) => col.name)).toEqual(
        expect.arrayContaining(["prompt_tokens", "completion_tokens", "cost_usd", "over_budget"]),
      );
      const row = await db.get<{ cost_usd: number; over_budget: number; prompt_tokens: number }>(
        `SELECT cost_usd, over_budget, prompt_tokens FROM sessions WHERE id = ?`,
        ["ses_old"],
      );
      expect(row).toMatchObject({ cost_usd: 0, over_budget: 0, prompt_tokens: 0 });
      await db.run(
        `INSERT INTO llm_calls
          (id, session_id, request_id, purpose, provider, model_id, prompt_tokens, completion_tokens, cost_usd, cost_source, created_at)
         VALUES ('llm_old', 'ses_old', 'req_old', 'grade', 'liquid', 'gpt-oss-120b', 3, 4, 1.5, 'provider', ?)`,
        [new Date().toISOString()],
      );
      const call = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_calls`);
      expect(Number(call?.n)).toBe(1);
    } finally {
      process.env.DATABASE_PATH = previous;
      resetDbForTests();
    }
  });

  it("stores every defense call, rolls a defend session up to the defense total, and flags over the budget", async () => {
    const user = await signIn("usage@fund.example");
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo, difficulty: "standard" });
    const learn = await startSession({ token: ingest.token, user, mode: "learn" });
    await learnCoachTurn({ sessionId: learn.sessionId, user, answer: "The recommendation rests on retention." });
    await generateFlashcards({ token: ingest.token, user });
    const defend = await startSession({ token: ingest.token, user, mode: "defend" });
    for (const probe of defend.plan.probes) {
      await recordDefendAnswer({
        sessionId: defend.sessionId,
        user,
        probeId: probe.id,
        answer:
          "Because the unit economics section shows churn near 1.2% and LTV/CAC above 3; if churn doubles the recommendation weakens first.",
      });
    }
    await completeDefendSession({ sessionId: defend.sessionId, user });

    const db = await getDb();
    const calls = await db.all<{
      purpose: string | null;
      provider: string;
      model_id: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost_usd: number;
      cost_source: string;
      session_id: string | null;
    }>(
      `SELECT purpose, provider, model_id, prompt_tokens, completion_tokens, cost_usd, cost_source, session_id
       FROM llm_calls WHERE request_id = ? ORDER BY created_at, id`,
      [ingest.requestId],
    );
    const purposes = calls.map((call) => call.purpose);
    expect(purposes).toContain("extract_claims");
    expect(purposes).toContain("learn_turn");
    expect(purposes).toContain("write_flashcards");
    expect(purposes).toContain("write_questions");
    expect(calls.filter((call) => call.purpose === "grade").map((call) => call.model_id).sort()).toEqual([
      "mock-council-balanced",
      "mock-council-lenient",
      "mock-council-strict",
    ]);
    expect(calls.every((call) => call.provider === "mock" && call.cost_source === "estimated")).toBe(true);
    expect(calls.every((call) => call.prompt_tokens > 0 && call.cost_usd > 0)).toBe(true);

    const defenseCost = calls.reduce((sum, call) => sum + call.cost_usd, 0);
    const defendRow = await db.get<{ cost_usd: number; over_budget: number; prompt_tokens: number; completion_tokens: number }>(
      `SELECT cost_usd, over_budget, prompt_tokens, completion_tokens FROM sessions WHERE id = ?`,
      [defend.sessionId],
    );
    expect(defendRow?.cost_usd).toBeCloseTo(defenseCost);
    expect(defendRow?.over_budget).toBe(0);
    expect(defendRow?.prompt_tokens).toBe(calls.reduce((sum, call) => sum + call.prompt_tokens, 0));
    expect(defendRow?.completion_tokens).toBe(calls.reduce((sum, call) => sum + call.completion_tokens, 0));

    const learnCalls = calls.filter((call) => call.session_id === learn.sessionId);
    const learnRow = await db.get<{ cost_usd: number; over_budget: number }>(
      `SELECT cost_usd, over_budget FROM sessions WHERE id = ?`,
      [learn.sessionId],
    );
    expect(learnCalls.length).toBeGreaterThan(0);
    expect(learnRow?.cost_usd).toBeCloseTo(learnCalls.reduce((sum, call) => sum + call.cost_usd, 0));
    expect(learnRow?.cost_usd).toBeLessThan(defenseCost);
    expect(learnRow?.over_budget).toBe(0);

    const listed = await listAdminSessions();
    const row = listed.find((session) => session.id === defend.sessionId);
    expect(row?.cost_usd).toBeCloseTo(defenseCost);
    expect(row?.over_budget).toBe(0);
    expect(row?.budget_usd).toBe(3);

    const detail = await getAdminSessionDetail(defend.sessionId);
    expect(detail?.usage.overBudget).toBe(false);
    expect(detail?.usage.costUsd).toBeCloseTo(defenseCost);
    expect(detail?.usage.calls.map((call) => call.purpose)).toEqual(purposes);

    delete process.env.MOCK_LLM;
    process.env.LIQUID_API_KEY = "liq_test";
    process.env.LLM_PROVIDER = "liquid";
    process.env.SESSION_BUDGET_USD = "3";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            model: "gpt-oss-120b",
            choices: [{ message: { content: "ok" } }],
            exchange: { charge: { total_usd: 4.25, cap_usd: 0.05 }, usage: { tokens_in: 100, tokens_out: 40 } },
          }),
          { status: 200 },
        ),
      ),
    );
    await withLlmScope({ sessionId: defend.sessionId, requestId: ingest.requestId }, () =>
      getPrimaryLlm().complete({
        messages: [{ role: "user", content: "one more grader" }],
        purpose: "grade",
      }),
    );

    const flagged = await db.get<{ cost_usd: number; over_budget: number }>(
      `SELECT cost_usd, over_budget FROM sessions WHERE id = ?`,
      [defend.sessionId],
    );
    expect(flagged?.over_budget).toBe(1);
    expect(flagged?.cost_usd).toBeGreaterThan(3);
    const providerCall = await db.get<{ prompt_tokens: number; completion_tokens: number; cost_usd: number; model_id: string }>(
      `SELECT prompt_tokens, completion_tokens, cost_usd, model_id FROM llm_calls
       WHERE request_id = ? AND cost_source = 'provider'`,
      [ingest.requestId],
    );
    expect(providerCall).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 40,
      cost_usd: 4.25,
      model_id: "gpt-oss-120b",
    });
    const after = await getAdminSessionDetail(defend.sessionId);
    expect(after?.usage.overBudget).toBe(true);
    expect(after?.usage.budgetUsd).toBe(3);

    process.env.MOCK_LLM = "1";
    delete process.env.LIQUID_API_KEY;
    delete process.env.LLM_PROVIDER;
    delete process.env.SESSION_BUDGET_USD;
    vi.unstubAllGlobals();
  });
});
