import { describe, expect, it } from "vitest";
import { groundEvidence, legacyAggregateScore, scoreDefense, simulateScoreVariance } from "../src/lib/score";
import type { InterviewPlan, ModelGrade } from "../src/lib/types";

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

  it("stays inside a tighter band than the holistic mean under sampling noise", () => {
    const good = simulateScoreVariance({ runs: 40, seed: "good-band", quality: "good" });
    const bad = simulateScoreVariance({ runs: 40, seed: "bad-band", quality: "bad" });
    expect(good.after.stdev).toBeLessThan(good.before.stdev);
    expect(good.after.max - good.after.min).toBeLessThanOrEqual(15);
    expect(bad.after.mean).toBeLessThan(good.after.mean - 20);
  });
});
