import { afterEach, describe, expect, it, vi } from "vitest";
import { gradeSession } from "../src/lib/grading";
import { groundEvidence, legacyAggregateScore, scoreDefense, simulateScoreVariance } from "../src/lib/score";
import type { Claim, InterviewPlan, ModelGrade, TurnRecord } from "../src/lib/types";

const plan: InterviewPlan = {
  seed: "t",
  difficulty: "hard",
  probes: [
    { id: "p1", claimId: "c1", type: "explain_back", difficulty: 1, question: "Explain.", expectedFocus: "x" },
    { id: "p2", claimId: "c2", type: "counterfactual", difficulty: 3, question: "What if?", expectedFocus: "y" },
  ],
};

function grade(modelId: string, levels: [number, number, number, number, number][], overallScore: number): ModelGrade {
  return {
    modelId,
    provider: "sim",
    overallScore,
    claimGrades: levels.map((scores, i) => ({
      probeId: plan.probes[i].id,
      claimId: plan.probes[i].claimId,
      section: "S",
      scores: {
        accuracy: scores[0],
        reasoning: scores[1],
        transfer: scores[2],
        errorDetection: scores[3],
        ownership: scores[4],
      },
      band: "Partial" as const,
      evidence: "quote",
      reason: "r",
    })),
  };
}

describe("analytic score", () => {
  it("uses the median level and ignores a holistic overallScore", () => {
    const grades = [
      grade("a", [[3, 3, 3, 0, 3], [2, 2, 2, 0, 2]], 4),
      grade("b", [[3, 3, 3, 0, 3], [2, 2, 3, 0, 2]], 4),
      grade("c", [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], 4),
    ];
    const scored = scoreDefense(grades, plan);
    // Median of the explain_back item is the 3s, not the outlier 0 and not the holistic 4.
    expect(scored.probes[0].score).toBeGreaterThan(70);
    expect(legacyAggregateScore(grades)).toBe(4);
    expect(scored.score).toBeGreaterThan(40);
    expect(scored.disputedProbeIds).toContain("p1");
  });

  it("weights a harder question more than an easier one", () => {
    const easyHigh = scoreDefense(
      [grade("a", [[4, 4, 4, 0, 4], [0, 0, 0, 0, 0]], 50)],
      plan,
    ).score;
    const hardHigh = scoreDefense(
      [grade("a", [[0, 0, 0, 0, 0], [4, 4, 4, 0, 4]], 50)],
      plan,
    ).score;
    expect(hardHigh).toBeGreaterThan(easyHigh);
  });

  it("caps accuracy when the evidence quote is not in the answer", () => {
    const grounded = groundEvidence(
      {
        claimId: "c",
        section: "S",
        scores: { accuracy: 4, reasoning: 4, transfer: 3, errorDetection: 0, ownership: 3 },
        band: "Strong",
        evidence: "churn near 1.2%",
        reason: "ok",
      },
      "The case rests on churn near 1.2% monthly.",
    );
    expect(grounded.scores.accuracy).toBe(4);
    const loose = groundEvidence(
      { ...grounded, evidence: "an invented quote" },
      "The case rests on churn near 1.2% monthly.",
    );
    expect(loose.scores.accuracy).toBe(1);
    expect(loose.scores.reasoning).toBe(1);
  });

  it("does not let one grader skipping a question pull the score down", async () => {
    process.env.MOCK_LLM = "1";
    const claims: Claim[] = [
      { id: "c1", text: "Monthly logo churn is 1.2%.", section: "Unit economics", sourceSpan: "1.2%", stakes: "high" },
      { id: "c2", text: "Payback on CAC is 11 months.", section: "Unit economics", sourceSpan: "11 months", stakes: "high" },
    ];
    const local: InterviewPlan = {
      seed: "skip",
      difficulty: "standard",
      probes: [
        { id: "p1", claimId: "c1", type: "explain_back", difficulty: 2, question: "Why does 1.2% hold?", expectedFocus: "1.2%", sourceSpan: "1.2%" },
        { id: "p2", claimId: "c2", type: "explain_back", difficulty: 2, question: "Why is payback 11 months?", expectedFocus: "11 months", sourceSpan: "11 months" },
      ],
    };
    const turns: TurnRecord[] = local.probes.map((probe, i) => ({
      id: `t${i}`,
      probeId: probe.id,
      question: probe.question,
      answer: "Because the figure holds in the document and I would check the source.",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1000).toISOString(),
      latencyMs: 4000,
      followUpIndex: 0,
    }));
    const llm = await import("../src/lib/llm");
    const calls: string[] = [];
    vi.spyOn(llm, "completeJson").mockImplementation(async (provider, req) => {
      const modelId = (provider as { id: string }).id;
      calls.push(modelId);
      const user = req.messages.map((message) => message.content).join("\n");
      expect(user).not.toMatch(/latency|latencyMs|startedAt|endedAt|Latency ms/);
      expect(req.temperature).toBe(0);
      expect(req.seed).toBe(0);
      const found = [...user.matchAll(/Probe id:\s*(\S+)[\s\S]*?Claim id:\s*(\S+)/g)].map((match) => ({
        probeId: match[1],
        claimId: match[2],
      }));
      const rows = modelId.includes("lenient") ? found.slice(0, -1) : found;
      return {
        data: {
          claimGrades: rows.map((row) => ({
            probeId: row.probeId,
            claimId: row.claimId,
            section: "Unit economics",
            scores: { accuracy: 3, reasoning: 3, transfer: 3, errorDetection: 0, ownership: 3 },
            band: "Strong" as const,
            evidence: "the figure holds",
            reason: "matches",
          })),
        },
        raw: { content: "", modelId, provider: "mock" },
      } as never;
    });
    const grades = await gradeSession({ difficulty: "standard", claims, plan: local, turns });
    expect(grades).toHaveLength(2);
    expect(grades.every((grade) => grade.temperature === 0 && grade.seed === 0)).toBe(true);
    expect(grades.every((grade) => grade.claimGrades.length === local.probes.length)).toBe(true);
    expect(calls.filter((id) => id.includes("lenient"))).toHaveLength(2);
    const honest = scoreDefense(grades, local).score;
    const penalized = scoreDefense(
      [
        grades[0],
        {
          ...grades[0],
          modelId: "gap",
          claimGrades: [
            grades[0].claimGrades[0],
            {
              ...grades[0].claimGrades[1],
              scores: { accuracy: 0, reasoning: 0, transfer: 0, errorDetection: 0, ownership: 0 },
            },
          ],
        },
      ],
      local,
    ).score;
    expect(honest).toBeGreaterThan(penalized);
  });

  it("stays inside a tighter band than the holistic mean under sampling noise", () => {
    const good = simulateScoreVariance({ runs: 40, seed: "good-band", quality: "good" });
    const bad = simulateScoreVariance({ runs: 40, seed: "bad-band", quality: "bad" });
    expect(good.after.stdev).toBeLessThan(good.before.stdev);
    expect(good.after.max - good.after.min).toBeLessThanOrEqual(15);
    expect(bad.after.mean).toBeLessThan(good.after.mean - 20);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
