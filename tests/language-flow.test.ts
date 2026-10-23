import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { resetDbForTests, getDb } from "../src/lib/db";
import { dueCards, generateFlashcards } from "../src/lib/flashcards";
import * as llm from "../src/lib/llm";
import { phraseQuestions } from "../src/lib/questions";
import {
  completeDefendSession,
  creatorIngest,
  learnCoachTurn,
  recordVoiceAnswer,
  startSession,
  voicePlan,
} from "../src/lib/services";
import { buildInterviewPlan } from "../src/lib/probes";
import type { Claim } from "../src/lib/types";

const spanish = readFileSync(join(__dirname, "..", "fixtures", "language", "casco-es.md"));
const portuguese = readFileSync(join(__dirname, "..", "fixtures", "language", "casco-pt.md"));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-lang-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "lang.db");
  process.env.DATA_ENCRYPTION_KEY = "44".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "55".repeat(32);
  delete process.env.DATABASE_URL;
  await resetDbForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signIn(email: string): Promise<User> {
  const { devLink } = await requestMagicLink({ email });
  return (await consumeMagicLink(devLink!.split("#token=")[1]))!.user;
}

describe("a Spanish upload", () => {
  it("stores es, asks in Spanish, and grades the full span without penalizing the language", async () => {
    const user = await signIn("casco-es@fund.example");
    const ingest = await creatorIngest({ user, fileName: "casco.md", buffer: spanish, difficulty: "hard" });
    const db = await getDb();
    const row = await db.get<{ language: string | null }>(`SELECT language FROM defense_requests WHERE id = ?`, [
      ingest.requestId,
    ]);
    expect(row?.language).toBe("es");

    const session = await startSession({ token: ingest.token, user, mode: "defend" });
    expect(session.channel).toBe("voice");
    const plan = await voicePlan(session.sessionId);
    expect(plan.language).toBe("es");
    const spoken = session.plan.probes.map((probe) => probe.question).join("\n");
    expect(spoken).toMatch(/¿/);
    expect(spoken).not.toMatch(/Walk me through|Got it\. Question|I'm your examiner/);
    for (const probe of session.plan.probes) {
      if (!probe.plantedContent) continue;
      expect(probe.question).toContain(probe.plantedContent);
      expect(probe.sourceSpan?.length ?? 0).toBeGreaterThan(probe.plantedContent.slice(0, 24).length);
    }

    const learn = await startSession({ token: ingest.token, user, mode: "learn" });
    const coach = await learnCoachTurn({ sessionId: learn.sessionId, user });
    expect(coach.coachMessage).toMatch(/documento/);
    expect(coach.coachMessage).not.toMatch(/Before we dig in/);

    await generateFlashcards({ token: ingest.token, user });
    const cards = await dueCards({ user, token: ingest.token });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((card) => /¿Qué (dice|recomienda|debes)/.test(card.front))).toBe(true);
    expect(cards.every((card) => !card.front.startsWith("What does the file"))).toBe(true);
    expect(cards.some((card) => /[áéíóúñ]/i.test(`${card.front} ${card.back} ${card.source ?? ""}`))).toBe(true);

    const spy = vi.spyOn(llm, "completeJson");
    const now = new Date().toISOString();
    for (const [index, probe] of session.plan.probes.entries()) {
      await recordVoiceAnswer({
        sessionId: session.sessionId,
        probeId: probe.id,
        answer:
          index === 0
            ? "Significa the mass phone"
            : "La estabilidad es la capacidad del buque para volver a adrizado, porque el centro de gravedad y el de carena lo devuelven. Si el peso sube, la escora cambia.",
        questionEndedAt: now,
        answerStartedAt: now,
        answerEndedAt: now,
      });
    }
    await completeDefendSession({ sessionId: session.sessionId, user });
    const graded = spy.mock.calls.map((call) => JSON.stringify(call[1]));
    expect(graded.some((body) => body.includes("Document language: es") && body.includes("Cited span (full)"))).toBe(true);
    expect(graded.some((body) => body.includes("must not be penalized") || body.includes("equally acceptable"))).toBe(true);
  });

  it("stores pt and does not open the interview in English", async () => {
    const user = await signIn("casco-pt@fund.example");
    const ingest = await creatorIngest({ user, fileName: "casco-pt.md", buffer: portuguese, difficulty: "standard" });
    const db = await getDb();
    const row = await db.get<{ language: string | null }>(`SELECT language FROM defense_requests WHERE id = ?`, [
      ingest.requestId,
    ]);
    expect(row?.language).toBe("pt");
    const session = await startSession({
      token: ingest.token,
      user,
      mode: "defend",
      accommodation: true,
    });
    const spoken = session.plan.probes.map((probe) => probe.question).join("\n");
    expect(spoken).toMatch(/documento|Explique|Quão|O que/);
    expect(spoken).not.toMatch(/Walk me through|Got it\. Question/);
  });
});

describe("a truncated planted quote", () => {
  it("is replaced with the full altered span before the question is accepted", async () => {
    process.env.MOCK_LLM = "1";
    const claim: Claim = {
      id: "c1",
      text: "Todo barco debe poseer seis propiedades: flotabilidad, estabilidad, estanqueidad, robustez, velocidad y gobierno.",
      section: "Casco",
      sourceSpan:
        "Todo barco debe poseer seis propiedades: flotabilidad, estabilidad, estanqueidad, robustez, velocidad y gobierno.",
      stakes: "high",
    };
    const plan = buildInterviewPlan({
      claims: [claim, { ...claim, id: "c2" }, { ...claim, id: "c3" }],
      difficulty: "hard",
      seed: "cut",
      language: "es",
    });
    const planted = plan.probes.find((probe) => probe.type === "planted_error")!;
    const cut = `${planted.plantedContent!.slice(0, 48)}, as`;
    vi.spyOn(llm, "completeJson").mockImplementation(async () => {
      return {
        data: {
          questions: plan.probes.map((probe) => ({
            probeId: probe.id,
            question:
              probe.type === "planted_error"
                ? `Your document lists six properties. "${cut}"`
                : `Explica por qué se sostiene "${claim.text}".`,
          })),
        },
        raw: { content: "", modelId: "m", provider: "mock" },
      } as never;
    });
    const out = await phraseQuestions(plan, [claim, { ...claim, id: "c2" }, { ...claim, id: "c3" }], { language: "es" });
    const question = out.probes.find((probe) => probe.id === planted.id)!.question;
    expect(question).toContain(planted.plantedContent);
    expect(question).not.toContain(", as");
    expect(out.probes.find((probe) => probe.id === planted.id)!.sourceSpan).toBe(claim.sourceSpan);
  });
});
