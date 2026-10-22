import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as startRoute } from "../src/app/api/sessions/start/route";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { resetDbForTests } from "../src/lib/db";
import { gradeSession } from "../src/lib/grading";
import { gradingProgressLabel } from "../src/lib/grading-progress";
import * as questions from "../src/lib/questions";
import { buildInterviewPlan } from "../src/lib/probes";
import {
  completeDefendSession,
  creatorIngest,
  getAdminSessionDetail,
  getDefendGradingProgress,
  recordDefendAnswer,
  startSession,
} from "../src/lib/services";
import type { Claim, InterviewPlan, TurnRecord } from "../src/lib/types";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));

const claims: Claim[] = [
  { id: "c1", text: "Monthly logo churn is 1.2%.", section: "Unit economics", sourceSpan: "1.2%", stakes: "high" },
  { id: "c2", text: "Payback on CAC is 11 months.", section: "Unit economics", sourceSpan: "11 months", stakes: "high" },
];

function plan(): InterviewPlan {
  return {
    seed: "latency",
    difficulty: "standard",
    probes: [
      { id: "p1", claimId: "c1", type: "explain_back", difficulty: 2, question: "Why does 1.2% hold?", expectedFocus: "1.2%", sourceSpan: "1.2%" },
      { id: "p2", claimId: "c2", type: "explain_back", difficulty: 2, question: "Why is payback 11 months?", expectedFocus: "11 months", sourceSpan: "11 months" },
    ],
  };
}

function turns(local: InterviewPlan): TurnRecord[] {
  return local.probes.map((probe, i) => ({
    id: `t${i}`,
    probeId: probe.id,
    question: probe.question,
    answer: "Because the figure holds in the document and the unit economics still work if it moves a little.",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
    latencyMs: 1000,
    followUpIndex: 0,
  }));
}

describe("grading progress label", () => {
  it("names how many graders have finished", () => {
    expect(gradingProgressLabel(null, false)).toBe("Grading council scoring…");
    expect(gradingProgressLabel({ done: 2, total: 3, stage: "grading" }, false)).toBe("2 of 3 graders done");
    expect(gradingProgressLabel({ done: 3, total: 3, stage: "aggregating" }, false)).toBe("Combining the council's scores…");
    expect(gradingProgressLabel({ done: 3, total: 3, stage: "signing" }, false)).toBe("Signing the receipt…");
    expect(gradingProgressLabel({ done: 1, total: 3, stage: "grading" }, true)).toBe("Grading didn't finish.");
  });
});

describe("council latency", () => {
  afterEach(() => {
    delete process.env.MOCK_GRADER_DELAY_MS;
    delete process.env.MOCK_GRADER_HANG_MODEL;
    delete process.env.GRADER_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it("runs the three graders together", async () => {
    process.env.MOCK_LLM = "1";
    process.env.MOCK_GRADER_DELAY_MS = "180";
    const durations: number[] = [];
    const started = Date.now();
    const grades = await gradeSession(
      { difficulty: "standard", claims, plan: plan(), turns: turns(plan()) },
      {
        onProgress: (progress) => {
          if (progress.durationMs !== undefined && progress.modelId) durations.push(progress.durationMs);
        },
      },
    );
    const wall = Date.now() - started;
    expect(grades).toHaveLength(3);
    expect(durations).toHaveLength(3);
    expect(Math.max(...durations)).toBeGreaterThanOrEqual(160);
    expect(wall).toBeLessThan(durations.reduce((sum, ms) => sum + ms, 0));
    expect(wall).toBeLessThan(450);
  });

  it("drops a hung grader at its timeout and keeps a majority", async () => {
    process.env.MOCK_LLM = "1";
    process.env.GRADER_TIMEOUT_MS = "80";
    process.env.MOCK_GRADER_HANG_MODEL = "mock-council-lenient";
    const started = Date.now();
    const grades = await gradeSession({ difficulty: "standard", claims, plan: plan(), turns: turns(plan()) });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(grades.map((grade) => grade.modelId).sort()).toEqual([
      "mock-council-balanced",
      "mock-council-strict",
    ]);
    expect(grades.every((grade) => grade.temperature === 0 && grade.seed === 0)).toBe(true);
  });
});

describe("interview timings", () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "defendit-latency-"));
    process.env.DATABASE_PATH = join(dir, "latency.db");
    delete process.env.DATABASE_URL;
    process.env.MOCK_LLM = "1";
    process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
    process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
    resetDbForTests();
  });

  afterEach(() => {
    delete process.env.MOCK_GRADER_DELAY_MS;
    delete process.env.MOCK_GRADER_HANG_MODEL;
    delete process.env.GRADER_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  async function signIn(email: string): Promise<{ user: User; cookie: string }> {
    const { devLink } = await requestMagicLink({ email });
    const token = devLink!.split("#token=")[1];
    const res = await consumeMagicLink(token);
    return { user: res!.user, cookie: `di_session=${res!.sessionToken}` };
  }

  it("phrases only the requested probes and leaves the others alone", async () => {
    const drafted = buildInterviewPlan({ claims, difficulty: "standard", seed: "partial" });
    drafted.probes[0] = { ...drafted.probes[0], question: "KEEP ME" };
    const out = await questions.phraseQuestions(drafted, claims, { indexes: [1] });
    expect(out.probes[0].question).toBe("KEEP ME");
    expect(out.probes[1].question.length).toBeGreaterThan(10);
  });

  it("shows the first question before the remaining questions are phrased", async () => {
    let restStarted = false;
    let sawFirstBeforeRest = false;
    const original = questions.phraseQuestions;
    vi.spyOn(questions, "phraseQuestions").mockImplementation(async (draft, claimList, opts) => {
      const indexes = opts?.indexes;
      if (indexes && !indexes.includes(0)) {
        restStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return original(draft, claimList, opts);
    });
    const { user } = await signIn("prefetch@fund.example");
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo, difficulty: "standard" });
    await startSession({
      token: ingest.token,
      user,
      mode: "defend",
      onFirstQuestion: () => {
        sawFirstBeforeRest = !restStarted;
      },
    });
    expect(sawFirstBeforeRest).toBe(true);
    expect(restStarted).toBe(true);
  });

  it("records stage timings and grading progress for a defense", async () => {
    process.env.MOCK_GRADER_DELAY_MS = "280";
    const { user } = await signIn("stages@fund.example");
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo, difficulty: "standard" });
    const session = await startSession({ token: ingest.token, user, mode: "defend" });
    for (const probe of session.plan.probes) {
      await recordDefendAnswer({
        sessionId: session.sessionId,
        user,
        probeId: probe.id,
        answer: "Because churn near 1.2% and LTV/CAC above 3 still support the round if churn rises a little.",
      });
    }
    const pending = completeDefendSession({ sessionId: session.sessionId, user, showName: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const mid = await getDefendGradingProgress(session.sessionId, user);
    expect(mid.status).toBe("grading");
    expect(mid.progress?.total).toBe(3);
    expect(mid.progress?.done).toBeLessThan(3);
    const done = await pending;
    expect(done.receipt?.payload.id).toBeTruthy();
    const graders = done.receipt?.payload.graders ?? [];
    expect(graders.length).toBeGreaterThan(0);
    expect(graders.every((grader) => grader.temperature === 0 && typeof grader.seed === "number")).toBe(true);

    const detail = await getAdminSessionDetail(session.sessionId);
    const stages = detail?.timings.map((timing) => timing.stage) ?? [];
    expect(stages).toEqual(expect.arrayContaining(["upload_parse", "first_question", "grader", "aggregation", "receipt_sign"]));
    expect(detail?.timings.filter((timing) => timing.stage === "grader")).toHaveLength(3);
    expect(detail?.timings.every((timing) => timing.durationMs >= 0)).toBe(true);
  });

  it("streams the first question and records first-audio timing", async () => {
    const { user, cookie } = await signIn("stream@fund.example");
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo, difficulty: "standard" });
    const req = new Request("http://localhost/api/sessions/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        Origin: "http://localhost",
        Host: "localhost",
        Cookie: cookie,
      },
      body: JSON.stringify({ token: ingest.token, mode: "defend" }),
    });
    const res = await startRoute(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; probe?: { question: string }; probes?: { question: string }[]; text?: string });
    expect(lines[0].type).toBe("question");
    expect(lines.some((line) => line.type === "audio")).toBe(true);
    expect(lines.at(-1)?.type).toBe("ready");
    expect(lines[0].probe?.question).toBe(lines.at(-1)?.probes?.[0].question);
    expect(JSON.stringify(lines)).not.toContain("expectedFocus");

    const sessionId = (lines.at(-1) as { sessionId?: string }).sessionId;
    const detail = await getAdminSessionDetail(sessionId!);
    expect(detail?.timings.some((timing) => timing.stage === "tts_first_audio" && timing.detail === "text-stream")).toBe(true);
  });
});
