import { describe, expect, it } from "vitest";
import { blueprintMix, buildInterviewPlan } from "../src/lib/probes";
import type { Claim } from "../src/lib/types";

const claims: Claim[] = [
  {
    id: "c1",
    text: "Recommend $12M investment based on 12x exit multiple.",
    section: "Recommendation",
    sourceSpan: "12x",
    stakes: "high",
  },
  {
    id: "c2",
    text: "TAM is $2.4B for regional freight software.",
    section: "Market",
    sourceSpan: "$2.4B",
    stakes: "medium",
  },
  {
    id: "c3",
    text: "Churn doubling cuts LTV by 40%.",
    section: "Unit economics",
    sourceSpan: "40%",
    stakes: "high",
  },
  {
    id: "c4",
    text: "Competitive response is the fragile assumption.",
    section: "Risks",
    sourceSpan: "competitive",
    stakes: "medium",
  },
  {
    id: "c5",
    text: "NRR is 118%.",
    section: "Market",
    sourceSpan: "118%",
    stakes: "low",
  },
];

describe("probe sampling", () => {
  it("is deterministic for the same seed", () => {
    const a = buildInterviewPlan({
      claims,
      difficulty: "hard",
      seed: "seed-alpha",
    });
    const b = buildInterviewPlan({
      claims,
      difficulty: "hard",
      seed: "seed-alpha",
    });
    expect(a.probes.map((p) => p.claimId)).toEqual(
      b.probes.map((p) => p.claimId),
    );
    expect(a.probes.map((p) => p.type)).toEqual(b.probes.map((p) => p.type));
  });

  it("differs across seeds", () => {
    const a = buildInterviewPlan({
      claims,
      difficulty: "expert",
      seed: "seed-1",
    });
    const b = buildInterviewPlan({
      claims,
      difficulty: "expert",
      seed: "seed-2",
    });
    const same =
      JSON.stringify(a.probes.map((p) => [p.claimId, p.type])) ===
      JSON.stringify(b.probes.map((p) => [p.claimId, p.type]));
    expect(same).toBe(false);
  });

  it("keeps the same mix of type and difficulty across seeds", () => {
    const seeds = ["a", "b", "c", "d", "e"];
    for (const difficulty of ["standard", "hard", "expert"] as const) {
      const mixes = seeds.map((seed) =>
        buildInterviewPlan({ claims, difficulty, seed }).probes.map((p) => `${p.type}:${p.difficulty}`).sort().join("|"),
      );
      expect(new Set(mixes).size).toBe(1);
      expect(mixes[0].split("|")).toEqual(blueprintMix(difficulty));
    }
  });

  it("includes a planted error on hard difficulty", () => {
    const plan = buildInterviewPlan({
      claims,
      difficulty: "hard",
      seed: "plant-me",
    });
    expect(plan.plantedErrorClaimId).toBeTruthy();
    expect(plan.probes.some((p) => p.type === "planted_error")).toBe(true);
  });
});
