import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInterviewPlan, makeFollowUpProbe } from "../src/lib/probes";
import { checkQuestion } from "../src/lib/question-check";
import { phraseQuestions } from "../src/lib/questions";
import type { Claim } from "../src/lib/types";

const memoClaims: Claim[] = [
  { id: "c1", text: "We recommend a $12M Series B at a $90M post-money valuation.", section: "Recommendation", sourceSpan: "$12M Series B", stakes: "high" },
  { id: "c2", text: "Monthly logo churn is 1.2% and net revenue retention is 118%.", section: "Unit economics", sourceSpan: "1.2%", stakes: "high" },
  { id: "c3", text: "Payback on CAC is 11 months at current sales efficiency.", section: "Unit economics", sourceSpan: "11 months", stakes: "high" },
  { id: "c4", text: "The serviceable market is $2.4B across mid-market logistics firms.", section: "Market", sourceSpan: "$2.4B", stakes: "medium" },
  { id: "c5", text: "The main risk is a pricing response from the two incumbents.", section: "Risks", sourceSpan: "pricing response", stakes: "medium" },
  { id: "c6", text: "Gross margin will expand from 61% to 70% as hosting costs fall.", section: "Margins", sourceSpan: "61% to 70%", stakes: "high" },
];

const prClaims: Claim[] = [
  { id: "p1", text: "The retry wrapper caps backoff at 30 seconds with full jitter.", section: "Retries", sourceSpan: "30 seconds", stakes: "high" },
  { id: "p2", text: "Idempotency keys are stored for 24 hours in Redis.", section: "Idempotency", sourceSpan: "24 hours", stakes: "high" },
  { id: "p3", text: "The migration adds a nullable column, so it is safe to deploy before the code.", section: "Migration", sourceSpan: "nullable column", stakes: "high" },
  { id: "p4", text: "Webhook delivery p99 latency drops from 900ms to 250ms.", section: "Performance", sourceSpan: "900ms to 250ms", stakes: "medium" },
  { id: "p5", text: "Failed deliveries go to a dead-letter queue reviewed daily.", section: "Operations", sourceSpan: "dead-letter queue", stakes: "medium" },
  { id: "p6", text: "Load tests at 3x peak traffic showed no dropped events.", section: "Testing", sourceSpan: "3x peak", stakes: "medium" },
];

beforeEach(() => {
  process.env.MOCK_LLM = "1";
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("interview plans vary", () => {
  it("does not always open with the same kind of question", () => {
    const firstTypes = new Set(
      Array.from({ length: 30 }, (_, i) =>
        buildInterviewPlan({ claims: memoClaims, difficulty: "hard", seed: `seed-${i}` }).probes[0].type,
      ),
    );
    expect(firstTypes.size).toBeGreaterThan(1);
  });

  it("varies template wording across seeds even without a model", () => {
    const openings = new Set(
      Array.from({ length: 30 }, (_, i) => {
        const plan = buildInterviewPlan({ claims: memoClaims, difficulty: "hard", seed: `s-${i}` });
        const explain = plan.probes.find((p) => p.type === "explain_back");
        return explain?.question.split(" ").slice(0, 3).join(" ");
      }).filter(Boolean),
    );
    expect(openings.size).toBeGreaterThan(2);
  });
});

describe("phraseQuestions", () => {
  it("writes different questions for different files", async () => {
    const a = await phraseQuestions(buildInterviewPlan({ claims: memoClaims, difficulty: "hard", seed: "x" }), memoClaims);
    const b = await phraseQuestions(buildInterviewPlan({ claims: prClaims, difficulty: "hard", seed: "x" }), prClaims);
    const qa = a.probes.map((p) => p.question);
    const qb = b.probes.map((p) => p.question);
    expect(qa.some((q) => qb.includes(q))).toBe(false);
    expect(qb.join(" ")).toMatch(/retry|idempotency|migration|webhook|dead-letter|load test/i);
    expect(a.probes.every((p) => (p.sourceSpan ?? "").length >= 4)).toBe(true);
  });

  it("keeps the planted-error excerpt verbatim after the model's lead-in", async () => {
    const plan = buildInterviewPlan({ claims: memoClaims, difficulty: "hard", seed: "planted" });
    const planted = plan.probes.find((p) => p.type === "planted_error")!;
    const out = await phraseQuestions(plan, memoClaims);
    const q = out.probes.find((p) => p.id === planted.id)!.question;
    expect(q).toContain(planted.plantedContent!);
  });

  it("falls back to the template for a probe the model gets wrong", async () => {
    const plan = buildInterviewPlan({ claims: memoClaims, difficulty: "standard", seed: "fb" });
    const llm = await import("../src/lib/llm");
    vi.spyOn(llm, "completeJson").mockResolvedValue({
      data: { questions: [{ probeId: plan.probes[0].id, question: "" }, { probeId: "nope", question: "x" }] },
      raw: { content: "", modelId: "m", provider: "mock" },
    } as never);
    const out = await phraseQuestions(plan, memoClaims);
    expect(out.probes.map((p) => p.question)).toEqual(plan.probes.map((p) => p.question));
  });

  it("rejects a question that is not grounded in the claim", async () => {
    const plan = buildInterviewPlan({ claims: memoClaims, difficulty: "standard", seed: "ground" });
    const llm = await import("../src/lib/llm");
    vi.spyOn(llm, "completeJson").mockResolvedValue({
      data: { questions: plan.probes.map((p) => ({ probeId: p.id, question: "What do you think about this in general terms?" })) },
      raw: { content: "", modelId: "m", provider: "mock" },
    } as never);
    const out = await phraseQuestions(plan, memoClaims);
    expect(out.probes.map((p) => p.question)).toEqual(plan.probes.map((p) => p.question));
  });

  it("keeps the template plan when the model call fails", async () => {
    const plan = buildInterviewPlan({ claims: memoClaims, difficulty: "standard", seed: "err" });
    const llm = await import("../src/lib/llm");
    vi.spyOn(llm, "completeJson").mockRejectedValue(new Error("timeout"));
    const out = await phraseQuestions(plan, memoClaims);
    expect(out.probes).toHaveLength(plan.probes.length);
    expect(out.probes.every((p) => p.question.length > 10)).toBe(true);
    expect(out.probes.every((p) => p.sourceSpan)).toBe(true);
  });

  it("rewrites a question once when the first draft fails the validity check", async () => {
    const plan = buildInterviewPlan({ claims: memoClaims, difficulty: "standard", seed: "regen" });
    const llm = await import("../src/lib/llm");
    let calls = 0;
    vi.spyOn(llm, "completeJson").mockImplementation(async () => {
      calls += 1;
      const questions =
        calls === 1
          ? plan.probes.map((p) => ({ probeId: p.id, question: "What do you think about this in general terms?" }))
          : plan.probes.map((p) => {
              const claim = memoClaims.find((c) => c.id === p.claimId)!;
              const question =
                p.type === "planted_error"
                  ? "Check this excerpt for me. Anything wrong with it?"
                  : `Explain why "${claim.text}" holds, citing ${claim.sourceSpan}.`;
              return { probeId: p.id, question };
            });
      return { data: { questions }, raw: { content: "", modelId: "m", provider: "mock" } } as never;
    });
    const out = await phraseQuestions(plan, memoClaims);
    expect(calls).toBe(2);
    for (const probe of out.probes) {
      const claim = memoClaims.find((c) => c.id === probe.claimId)!;
      expect(probe.sourceSpan).toBe(claim.sourceSpan);
      expect(probe.question).not.toMatch(/general terms/);
      const check = checkQuestion({
        question: probe.question,
        claim,
        probeType: probe.type,
        plantedContent: probe.plantedContent,
      });
      expect(check.ok).toBe(true);
    }
  });
});

describe("question validity", () => {
  it("accepts template questions and stores the cited span", () => {
    for (const difficulty of ["standard", "hard", "expert"] as const) {
      for (const seed of ["a", "b", "c"]) {
        const plan = buildInterviewPlan({ claims: memoClaims, difficulty, seed });
        for (const probe of plan.probes) {
          const claim = memoClaims.find((c) => c.id === probe.claimId)!;
          expect(probe.sourceSpan).toBe(claim.sourceSpan);
          const check = checkQuestion({
            question: probe.question,
            claim,
            probeType: probe.type,
            plantedContent: probe.plantedContent,
          });
          expect(check.ok, `${probe.type} ${seed}: ${check.reasons.join("; ")} :: ${probe.question}`).toBe(true);
        }
      }
    }
  });

  it("rejects an ungrounded question, three questions, and an outside lookup", () => {
    const claim = memoClaims[0];
    expect(checkQuestion({ question: "What do you think about this in general terms?", claim, probeType: "explain_back" }).grounded).toBe(false);
    expect(
      checkQuestion({
        question: `What about "${claim.text}"? Why does it hold? Are you sure?`,
        claim,
        probeType: "explain_back",
      }).unambiguous,
    ).toBe(false);
    expect(
      checkQuestion({
        question: `Look this up on google: is "${claim.sourceSpan}" in "${claim.text}" right?`,
        claim,
        probeType: "explain_back",
      }).answerable,
    ).toBe(false);
  });

  it("cites the source span on a follow-up", () => {
    const claim = memoClaims[1];
    const plan = buildInterviewPlan({ claims: memoClaims, difficulty: "standard", seed: "fu" });
    const extra = makeFollowUpProbe(claim, plan.probes[0]);
    expect(extra.sourceSpan).toBe(claim.sourceSpan);
    expect(checkQuestion({ question: extra.question, claim, probeType: extra.type }).ok).toBe(true);
  });
});

describe("plantError", () => {
  it("changes a number when there is one", async () => {
    const { plantError } = await import("../src/lib/probes");
    const out = plantError("Payback on CAC is 11 months at current sales efficiency.", () => 0.9);
    expect(out).not.toContain("11 months");
    expect(out).toMatch(/\d+ months/);
  });

  it("flips a meaning-bearing word when there is no number", async () => {
    const { plantError } = await import("../src/lib/probes");
    const out = plantError("The migration adds a nullable column, so it is safe to deploy before the code.", () => 0.1);
    expect(out).not.toBe("The migration adds a nullable column, so it is safe to deploy before the code.");
    expect(out).not.toMatch(/audit/);
  });
});
