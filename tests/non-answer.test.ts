import { beforeEach, describe, expect, it } from "vitest";
import { gradeSession } from "../src/lib/grading";
import { detectNonAnswer } from "../src/lib/non-answer";
import { buildInterviewPlan } from "../src/lib/probes";
import { scoreDefense } from "../src/lib/score";
import type { Claim, ProbeType, TurnRecord } from "../src/lib/types";

const claimText = "Monthly logo churn is 1.2% and net revenue retention is 118%.";
const question = 'Walk me through why "Monthly logo churn is 1.2%" holds. What in the document supports it?';

function judge(answer: string, probeType: ProbeType = "explain_back", asked = question) {
  return detectNonAnswer({
    answer,
    question: asked,
    claimText,
    sourceSpan: "1.2%",
    figures: ["1.2%", "118%"],
    probeType,
  });
}

const claims: Claim[] = [
  { id: "c1", text: "We recommend a $12M Series B at a $90M post-money valuation.", section: "Recommendation", sourceSpan: "$12M Series B", stakes: "high", figures: ["$12M", "$90M"] },
  { id: "c2", text: claimText, section: "Unit economics", sourceSpan: "1.2%", stakes: "high", figures: ["1.2%", "118%"] },
  { id: "c3", text: "Payback on CAC is 11 months at current sales efficiency.", section: "Unit economics", sourceSpan: "11 months", stakes: "high", figures: ["11"] },
  { id: "c4", text: "The serviceable market is $2.4B across mid-market logistics firms.", section: "Market", sourceSpan: "$2.4B", stakes: "medium", figures: ["$2.4B"] },
  { id: "c5", text: "The main risk is a pricing response from the two incumbents.", section: "Risks", sourceSpan: "pricing response", stakes: "medium" },
  { id: "c6", text: "Gross margin will expand from 61% to 70% as hosting costs fall.", section: "Margins", sourceSpan: "61% to 70%", stakes: "high", figures: ["61%", "70%"] },
];

beforeEach(() => {
  process.env.MOCK_LLM = "1";
});

describe("detectNonAnswer", () => {
  it("flags blank, refusal, evasive, off-topic, and a restatement of the question", () => {
    expect(judge("")).toMatchObject({ kind: "blank" });
    expect(judge("   ")).toMatchObject({ kind: "blank" });
    expect(judge("n/a")).toMatchObject({ kind: "blank" });
    expect(judge("I don't know.")).toMatchObject({ kind: "refusal" });
    expect(judge("idk")).toMatchObject({ kind: "refusal" });
    expect(judge("I don't know, I guess it's fine.")).toMatchObject({ kind: "refusal" });
    expect(judge("I guess it's fine.")).toMatchObject({ kind: "evasive" });
    expect(judge("sounds good")).toMatchObject({ kind: "evasive" });
    expect(judge("ok")).toMatchObject({ kind: "evasive" });
    expect(judge("The weather in Lisbon is lovely and I had pasta for lunch.")).toMatchObject({ kind: "off_topic" });
    expect(judge(question)).toMatchObject({ kind: "restatement" });
  });

  it("keeps an answer that cites the figure, including a hedged one", () => {
    expect(judge("Churn is 1.2%.")).toBeNull();
    expect(
      judge("I'm not sure of the exact wording, but churn is 1.2% because the cohort stays."),
    ).toBeNull();
  });

  it("does not treat a planted-error catch as a non-answer", () => {
    expect(judge("That excerpt was altered.", "planted_error")).toBeNull();
    expect(judge("The figure does not match what I wrote.", "planted_error")).toBeNull();
    expect(judge("I don't know.", "planted_error")?.kind).toBe("refusal");
  });
});

describe("gradeSession non-answers", () => {
  it("scores an all-I-don't-know defense at 0 on every dimension", async () => {
    const plan = buildInterviewPlan({ claims, difficulty: "standard", seed: "idk" });
    const turns = turnsFor(plan, () => "I don't know.");
    const grades = await gradeSession({ difficulty: "standard", claims, plan, turns });
    const scored = scoreDefense(grades, plan);
    expect(scored.score).toBe(0);
    expect(scored.claimScores.every((n) => n === 0)).toBe(true);
    expect(scored.disputedProbeIds).toEqual([]);
    for (const grade of grades) {
      expect(grade.claimGrades).toHaveLength(plan.probes.length);
      for (const row of grade.claimGrades) {
        expect(row.scores).toEqual({ accuracy: 0, reasoning: 0, transfer: 0, errorDetection: 0, ownership: 0 });
        expect(row.band).toBe("Weak");
      }
    }
  });

  it("zeros only the question that was not answered", async () => {
    const plan = buildInterviewPlan({ claims, difficulty: "standard", seed: "mix" });
    const skipped = plan.probes[0];
    const turns = turnsFor(plan, (probeId) => {
      if (probeId === skipped.id) return "I don't know.";
      const probe = plan.probes.find((p) => p.id === probeId)!;
      const claim = claims.find((c) => c.id === probe.claimId)!;
      return `Because the document says "${claim.text}". If that assumption moved, the conclusion would weaken, and I would check the source figure.`;
    });
    const grades = await gradeSession({ difficulty: "standard", claims, plan, turns });
    const scored = scoreDefense(grades, plan);
    const missed = scored.probes.find((p) => p.probeId === skipped.id)!;
    expect(missed.score).toBe(0);
    expect(scored.probes.some((p) => p.probeId !== skipped.id && p.score > 0)).toBe(true);
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.disputedProbeIds).not.toContain(skipped.id);
  });
});

function turnsFor(
  plan: { probes: { id: string; question: string }[] },
  answerFor: (probeId: string) => string,
): TurnRecord[] {
  return plan.probes.map((probe, i) => ({
    id: `turn_${i}`,
    probeId: probe.id,
    question: probe.question,
    answer: answerFor(probe.id),
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
    latencyMs: 1000,
    followUpIndex: 0,
  }));
}
