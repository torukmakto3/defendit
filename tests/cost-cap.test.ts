import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import {
  budgetUsdForTier,
  getCostTier,
  secondRoundFits,
  summarizeCosts,
  voiceCostUsd,
} from "../src/lib/cost";
import { getDb, resetDbForTests } from "../src/lib/db";
import { newId } from "../src/lib/ids";
import { getPrimaryLlm, LlmBudgetError, withLlmScope } from "../src/lib/llm";
import { beginBudget, releaseBudget } from "../src/lib/llm/usage";
import {
  adminSessionsCsv,
  completeDefendSession,
  creatorIngest,
  listAdminSessions,
  recordDefendAnswer,
  recordSessionVoiceUsage,
  startSession,
} from "../src/lib/services";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));

const ENV_KEYS = [
  "SESSION_BUDGET_USD",
  "SESSION_BUDGET_USD_CONSUMER",
  "SESSION_BUDGET_USD_ENTERPRISE",
  "COST_TIER_ENTERPRISE_EMAILS",
  "ADMIN_EMAILS",
  "LLM_CALL_RESERVE_USD",
  "CHEAP_LLM_RESERVE_USD",
  "LLM_PRICE_INPUT_PER_MTOK",
  "LLM_PRICE_OUTPUT_PER_MTOK",
  "MOCK_LLM",
  "LIVEKIT_RATE_AGENT_MIN",
  "LIVEKIT_RATE_STT_MIN",
  "LIVEKIT_RATE_TTS_MIN",
];

describe("cost tier and rates", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("treats everyone as a consumer except admins and the allowlist", () => {
    delete process.env.ADMIN_EMAILS;
    delete process.env.COST_TIER_ENTERPRISE_EMAILS;
    expect(getCostTier(null)).toBe("consumer");
    expect(getCostTier({ email: "person@fund.example" })).toBe("consumer");

    process.env.ADMIN_EMAILS = "Boss@Fund.example";
    expect(getCostTier({ email: "boss@fund.example" })).toBe("enterprise");

    delete process.env.ADMIN_EMAILS;
    process.env.COST_TIER_ENTERPRISE_EMAILS = "cfo@fund.example,*@internal.example";
    expect(getCostTier({ email: "cfo@fund.example" })).toBe("enterprise");
    expect(getCostTier({ email: "qa@internal.example" })).toBe("enterprise");
    expect(getCostTier({ email: "person@fund.example" })).toBe("consumer");
  });

  it("uses $0.75 and $3 unless a tier variable or SESSION_BUDGET_USD is set", () => {
    delete process.env.SESSION_BUDGET_USD;
    delete process.env.SESSION_BUDGET_USD_CONSUMER;
    delete process.env.SESSION_BUDGET_USD_ENTERPRISE;
    expect(budgetUsdForTier("consumer")).toBe(0.75);
    expect(budgetUsdForTier("enterprise")).toBe(3);

    process.env.SESSION_BUDGET_USD = "1.25";
    expect(budgetUsdForTier("consumer")).toBe(1.25);
    expect(budgetUsdForTier("enterprise")).toBe(1.25);

    process.env.SESSION_BUDGET_USD_CONSUMER = "0.5";
    process.env.SESSION_BUDGET_USD_ENTERPRISE = "4";
    expect(budgetUsdForTier("consumer")).toBe(0.5);
    expect(budgetUsdForTier("enterprise")).toBe(4);
  });

  it("prices LiveKit minutes and summarizes a defense window", () => {
    delete process.env.LIVEKIT_RATE_AGENT_MIN;
    delete process.env.LIVEKIT_RATE_STT_MIN;
    delete process.env.LIVEKIT_RATE_TTS_MIN;
    // 10 min agent, 2 min STT, 3 min TTS.
    expect(voiceCostUsd({ agentSeconds: 600, sttSeconds: 120, ttsSeconds: 180 })).toBeCloseTo(
      10 * 0.01 + 2 * 0.0048 + 3 * 0.009,
    );
    const summary = summarizeCosts([
      { totalUsd: 0.2, llmUsd: 0.15, voiceUsd: 0.05, capped: false },
      { totalUsd: 0.4, llmUsd: 0.4, voiceUsd: 0, capped: true },
      { totalUsd: 0.9, llmUsd: 0.5, voiceUsd: 0.4, capped: false },
    ]);
    expect(summary.count).toBe(3);
    expect(summary.cappedCount).toBe(1);
    expect(summary.p50Usd).toBe(0.4);
    expect(summary.p90Usd).toBe(0.9);
    expect(summary.maxUsd).toBe(0.9);
    expect(summary.llmUsd).toBeCloseTo(1.05);
    expect(summary.voiceUsd).toBeCloseTo(0.45);
    expect(secondRoundFits(0.61, 0.75, 3)).toBe(false);
    expect(secondRoundFits(0.61, 3, 3)).toBe(true);
  });

  it("prefixes formula-like CSV cells so a spreadsheet does not evaluate them", () => {
    const csv = adminSessionsCsv([
      {
        id: "=1+1",
        title: "=1,2",
        creator_email: "+cmd",
        difficulty: "-1",
        status: "@sum",
        cost_tier: "consumer",
        budget_usd: 0.75,
        llm_cost_usd: 0.1,
        voice_cost_usd: 0.2,
        total_cost_usd: 0.3,
        budget_capped: 0,
      },
      {
        id: "ses_ok",
        title: "\t=tab",
        creator_email: "\r=cr",
        difficulty: "standard",
        status: "completed",
        cost_tier: "consumer",
        budget_usd: 0.75,
        llm_cost_usd: 0,
        voice_cost_usd: 0,
        total_cost_usd: 0,
        budget_capped: 0,
      },
    ]);
    const [header, formula, control] = csv.split("\n");
    expect(header.startsWith("id,title,")).toBe(true);
    expect(formula).toContain("'=1+1");
    expect(formula).toContain(`"'=1,2"`);
    expect(formula).toContain("'+cmd");
    expect(formula).toContain("'-1");
    expect(formula).toContain("'@sum");
    expect(control).toContain("'\t=tab");
    expect(control).toContain("'\r=cr");
    expect(control).toContain("ses_ok");
  });
});

describe("defense cost cap", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    const dir = mkdtempSync(join(tmpdir(), "defendit-cost-"));
    process.env.DATABASE_PATH = join(dir, "cost.db");
    delete process.env.DATABASE_URL;
    process.env.MOCK_LLM = "1";
    process.env.DATA_ENCRYPTION_KEY = "44".repeat(32);
    process.env.DEFEND_IT_SIGNING_SEED = "55".repeat(32);
    delete process.env.SESSION_BUDGET_USD;
    delete process.env.SESSION_BUDGET_USD_CONSUMER;
    delete process.env.SESSION_BUDGET_USD_ENTERPRISE;
    delete process.env.ADMIN_EMAILS;
    process.env.LLM_CALL_RESERVE_USD = "0.05";
    process.env.CHEAP_LLM_RESERVE_USD = "0.01";
    process.env.LLM_PRICE_INPUT_PER_MTOK = "0";
    process.env.LLM_PRICE_OUTPUT_PER_MTOK = "0";
    resetDbForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (key === "MOCK_LLM" || key === "LLM_CALL_RESERVE_USD" || key === "CHEAP_LLM_RESERVE_USD") continue;
      if (key === "LLM_PRICE_INPUT_PER_MTOK" || key === "LLM_PRICE_OUTPUT_PER_MTOK") continue;
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.COST_TIER_ENTERPRISE_EMAILS;
    delete process.env.ADMIN_EMAILS;
    delete process.env.SESSION_BUDGET_USD;
  });

  async function signIn(email: string): Promise<User> {
    const { devLink } = await requestMagicLink({ email });
    return (await consumeMagicLink(devLink!.split("#token=")[1]))!.user;
  }

  async function seedSpend(requestId: string, cost: number, purpose = "seed"): Promise<void> {
    const db = await getDb();
    await db.run(
      `INSERT INTO llm_calls
        (id, session_id, request_id, purpose, provider, model_id, prompt_tokens, completion_tokens, cost_usd, cost_source, created_at)
       VALUES (?, NULL, ?, ?, 'liquid', 'gpt-oss-120b', 1, 1, ?, 'provider', ?)`,
      [newId("llm"), requestId, purpose, cost, new Date().toISOString()],
    );
  }

  it("skips an optional call and downgrades a required one once $0.75 would be passed", async () => {
    const user = { email: "person@fund.example" };
    const requestId = "req_consumer_gate";
    await seedSpend(requestId, 0.74);
    await expect(
      withLlmScope({ user, requestId }, () =>
        getPrimaryLlm().complete({
          messages: [{ role: "user", content: "Say this aloud" }],
          purpose: "speakable_rewrite",
        }),
      ),
    ).rejects.toBeInstanceOf(LlmBudgetError);

    const db = await getDb();
    const skipped = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM llm_calls WHERE request_id = ? AND purpose = 'speakable_rewrite'`,
      [requestId],
    );
    expect(Number(skipped?.n)).toBe(0);

    await seedSpend("req_cheap", 0.73);
    const downgraded = await withLlmScope({ user, requestId: "req_cheap" }, () =>
      getPrimaryLlm().complete({
        messages: [{ role: "user", content: "Extract the claims" }],
        purpose: "extract_claims",
        json: true,
      }),
    );
    expect(downgraded.modelId).toBe("llama-3.1-8b-instruct");
  });

  it("lets an enterprise defense keep the configured model at the same spend", async () => {
    process.env.COST_TIER_ENTERPRISE_EMAILS = "*@internal.example";
    const user = { email: "qa@internal.example" };
    expect(getCostTier(user)).toBe("enterprise");
    expect(budgetUsdForTier("enterprise")).toBe(3);
    await seedSpend("req_enterprise_gate", 0.8);
    const res = await withLlmScope({ user, requestId: "req_enterprise_gate" }, () =>
      getPrimaryLlm().complete({
        messages: [{ role: "user", content: "Say this aloud" }],
        purpose: "speakable_rewrite",
      }),
    );
    expect(res.modelId).toBe("mock-defend-v1");
  });

  it("stops extra coach turns without dropping the first one", async () => {
    const user = { email: "coach@fund.example" };
    const requestId = "req_coach";
    await seedSpend(requestId, 0.7, "learn_turn");
    const first = await withLlmScope({ user, requestId }, () =>
      getPrimaryLlm().complete({
        messages: [{ role: "user", content: "Start the session." }],
        purpose: "learn_turn",
        json: true,
      }),
    );
    expect(first.modelId).toBe("mock-defend-v1");

    await seedSpend(requestId, 0.04, "pad");
    await expect(
      withLlmScope({ user, requestId }, () =>
        getPrimaryLlm().complete({
          messages: [{ role: "user", content: "Another turn" }],
          purpose: "learn_turn",
          json: true,
        }),
      ),
    ).rejects.toBeInstanceOf(LlmBudgetError);
    const db = await getDb();
    const turns = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM llm_calls WHERE request_id = ? AND purpose = 'learn_turn' AND provider = 'mock'`,
      [requestId],
    );
    expect(Number(turns?.n)).toBe(1);
  });

  async function defend(email: string, enterprise: boolean) {
    if (enterprise) process.env.COST_TIER_ENTERPRISE_EMAILS = "*@internal.example";
    const user = await signIn(email);
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo, difficulty: "standard" });
    const session = await startSession({ token: ingest.token, user, mode: "defend" });
    await seedSpend(ingest.requestId, 0.61);
    const answer =
      "Because retention holds near 1.2 percent and the unit economics still clear the bar if churn rises. FORCE_DISAGREE";
    for (const probe of session.plan.probes) {
      await recordDefendAnswer({ sessionId: session.sessionId, user, probeId: probe.id, answer });
    }
    const result = await completeDefendSession({ sessionId: session.sessionId, user });
    const db = await getDb();
    const row = await db.get<{ budget_usd: number; budget_capped: number; cost_tier: string }>(
      `SELECT budget_usd, budget_capped, cost_tier FROM sessions WHERE id = ?`,
      [session.sessionId],
    );
    const grades = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM llm_calls WHERE request_id = ? AND purpose = 'grade'`,
      [ingest.requestId],
    );
    return { result, row, gradeCalls: Number(grades?.n), sessionId: session.sessionId, requestId: ingest.requestId };
  }

  it("produces a graded receipt for a consumer once a second round would pass $0.75", async () => {
    const { result, row, gradeCalls, sessionId } = await defend("consumer@fund.example", false);
    expect(result).toHaveProperty("receipt");
    expect(result).not.toHaveProperty("followUp");
    expect(row?.cost_tier).toBe("consumer");
    expect(row?.budget_usd).toBe(0.75);
    expect(row?.budget_capped).toBe(1);
    expect(gradeCalls).toBeGreaterThan(0);
    expect(gradeCalls).toBeLessThanOrEqual(3);

    await recordSessionVoiceUsage({
      sessionId,
      agentSeconds: 600,
      sttSeconds: 120,
      ttsSeconds: 180,
    });
    const listed = await listAdminSessions();
    const shown = listed.sessions.find((session) => session.id === sessionId);
    const voice = 10 * 0.01 + 2 * 0.0048 + 3 * 0.009;
    expect(shown?.voice_cost_usd).toBeCloseTo(voice);
    expect(shown?.total_cost_usd).toBeCloseTo((shown?.llm_cost_usd ?? 0) + voice);
    expect(shown?.budget_capped).toBe(1);
    expect(listed.summary.cappedCount).toBeGreaterThan(0);
    expect(listed.summary.voiceUsd).toBeGreaterThan(0);
    expect(listed.summary.p50Usd).toBeGreaterThan(0);
  });

  it("uses the $3 enterprise cap and still asks the follow-up", async () => {
    const { result, row, gradeCalls } = await defend("qa@internal.example", true);
    expect(result).toHaveProperty("followUp");
    expect(result).not.toHaveProperty("receipt");
    expect(row?.cost_tier).toBe("enterprise");
    expect(row?.budget_usd).toBe(3);
    expect(row?.budget_capped).toBe(0);
    expect(gradeCalls).toBe(3);
  });

  it("lets only one of two concurrent requests reserve the last slice of the cap", async () => {
    const cheap = process.env.CHEAP_LLM_RESERVE_USD;
    process.env.CHEAP_LLM_RESERVE_USD = "0.05";
    try {
      const user = await signIn("race@fund.example");
      const ingest = await creatorIngest({ user, fileName: "race.md", buffer: memo, difficulty: "standard" });
      const session = await startSession({ token: ingest.token, user, mode: "defend" });
      const db = await getDb();
      const before = await db.get<{ cost_usd: number; reserved_usd: number; voice_cost_usd: number }>(
        `SELECT cost_usd, reserved_usd, voice_cost_usd FROM sessions WHERE id = ?`,
        [session.sessionId],
      );
      const spent = Number(before?.cost_usd ?? 0) + Number(before?.reserved_usd ?? 0) + Number(before?.voice_cost_usd ?? 0);
      await db.run(`UPDATE sessions SET budget_usd = ? WHERE id = ?`, [spent + 0.05, session.sessionId]);

      let reservedWhileBothWaited = -1;
      let arrived = 0;
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const attempt = () =>
        withLlmScope({ sessionId: session.sessionId, requestId: ingest.requestId, user }, async () => {
          const decision = await beginBudget({
            purpose: "extract_claims",
            modelId: "mock-defend-v1",
            promptText: "Extract the claims",
          });
          arrived += 1;
          if (arrived === 2) {
            const mid = await db.get<{ reserved_usd: number }>(
              `SELECT reserved_usd FROM sessions WHERE id = ?`,
              [session.sessionId],
            );
            reservedWhileBothWaited = Number(mid?.reserved_usd ?? 0);
            openGate();
          }
          await gate;
          await releaseBudget(decision.reservationId);
          return decision.allow;
        });

      const [first, second] = await Promise.all([attempt(), attempt()]);
      const allowed = [first, second].filter(Boolean);
      expect(allowed).toHaveLength(1);
      expect(reservedWhileBothWaited).toBeCloseTo(0.05);
      const after = await db.get<{ reserved_usd: number }>(
        `SELECT reserved_usd FROM sessions WHERE id = ?`,
        [session.sessionId],
      );
      expect(Number(after?.reserved_usd ?? 0)).toBeCloseTo(0);
    } finally {
      process.env.CHEAP_LLM_RESERVE_USD = cheap;
    }
  });
});
