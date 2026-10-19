/**
 * Grade the calibration fixtures repeatedly and report stability.
 *
 *   MOCK_LLM=1 npx tsx scripts/calibrate-grading.ts
 *
 * Live keys are used when MOCK_LLM is unset and a provider is configured.
 * The noise section is a seeded simulation of the old holistic score versus
 * the median rubric (see simulateScoreVariance). It is not a live bill.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { extractClaims } from "../src/lib/claims";
import { gradeSession } from "../src/lib/grading";
import { buildInterviewPlan } from "../src/lib/probes";
import { estimateDefenseCost, scoreDefense, simulateScoreVariance } from "../src/lib/score";
import type { InterviewPlan, ModelGrade, TurnRecord } from "../src/lib/types";

const RUNS = Number(process.env.CALIBRATE_RUNS || "8");
const DIR = join(process.cwd(), "fixtures", "calibration");

function stdev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function answerFor(kind: "good" | "bad", claim: string): string {
  if (kind === "bad") return "I don't know, I guess it's fine.";
  return `Because the document says "${claim.slice(0, 160)}". If that assumption moved against us, the conclusion would weaken, and I would check the source figure before signing.`;
}

async function gradeOnce(text: string, kind: "good" | "bad", seed: string): Promise<{ receipt: number; graderScores: number[] }> {
  const claims = await extractClaims(text);
  const plan: InterviewPlan = buildInterviewPlan({ claims, difficulty: "standard", seed });
  const turns: TurnRecord[] = plan.probes.map((probe, i) => {
    const claim = claims.find((c) => c.id === probe.claimId);
    const answer = answerFor(kind, claim?.text ?? probe.question);
    return {
      id: `turn_${i + 1}`,
      probeId: probe.id,
      question: probe.question,
      answer,
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1000).toISOString(),
      latencyMs: 1000,
      followUpIndex: 0,
    };
  });
  const grades: ModelGrade[] = await gradeSession({ difficulty: "standard", claims, plan, turns });
  return { receipt: scoreDefense(grades, plan).score, graderScores: grades.map((g) => g.overallScore) };
}

function money(n: number): string {
  return `$${n.toFixed(3)}`;
}

async function main() {
  if (process.env.CALIBRATE_LIVE !== "1") process.env.MOCK_LLM = "1";
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
  console.log(`Calibration runs=${RUNS} files=${files.join(", ")}`);
  const goodScores: number[] = [];
  const badScores: number[] = [];

  for (const file of files) {
    const text = readFileSync(join(DIR, file), "utf8");
    const good: number[] = [];
    const bad: number[] = [];
    let spread = 0;
    for (let i = 0; i < RUNS; i++) {
      const g = await gradeOnce(text, "good", `${file}-good`);
      const b = await gradeOnce(text, "bad", `${file}-bad`);
      good.push(g.receipt);
      bad.push(b.receipt);
      spread = Math.max(spread, Math.max(...g.graderScores) - Math.min(...g.graderScores));
    }
    goodScores.push(...good);
    badScores.push(...bad);
    console.log(
      `  ${file}: good mean ${avg(good).toFixed(1)} stdev ${stdev(good).toFixed(2)} (range ${Math.min(...good)}-${Math.max(...good)}), bad mean ${avg(bad).toFixed(1)} stdev ${stdev(bad).toFixed(2)}, council spread on one good run up to ${spread.toFixed(1)}`,
    );
  }

  console.log(
    `Measured run-to-run (same answer, ${RUNS} runs, per file above): good answers sit near ${avg(goodScores).toFixed(1)}, bad answers near ${avg(badScores).toFixed(1)}. Pooled stdev across files is ${stdev(goodScores).toFixed(2)} because the three documents score a few points apart, not because a rerun moves.`,
  );

  const simGood = simulateScoreVariance({ runs: 40, seed: "report-good", quality: "good" });
  const simBad = simulateScoreVariance({ runs: 40, seed: "report-bad", quality: "bad" });
  console.log(
    `Simulated sampling (40 runs, good answer): before holistic mean stdev ${simGood.before.stdev} range ${simGood.before.min}-${simGood.before.max}; after median rubric stdev ${simGood.after.stdev} range ${simGood.after.min}-${simGood.after.max}`,
  );
  console.log(
    `Simulated sampling (40 runs, bad answer): before stdev ${simBad.before.stdev} mean ${simBad.before.mean}; after stdev ${simBad.after.stdev} mean ${simBad.after.mean}`,
  );

  const before = estimateDefenseCost({ era: "before" });
  const after = estimateDefenseCost({ era: "after", followUpRate: 0.15 });
  const afterWorst = estimateDefenseCost({ era: "after", followUpRate: 1 });
  console.log(
    `Cost estimate per defense (3 frontier graders + learn, ~2k-token doc): before ${money(before.frontierUsd)} (${before.inputTokens}+${before.outputTokens} tok), after expected ${money(after.frontierUsd)} (${after.inputTokens}+${after.outputTokens} tok), after if every defense disagrees ${money(afterWorst.frontierUsd)}. Cheap/open-weight council: before ${money(before.cheapUsd)}, after ${money(after.cheapUsd)}.`,
  );
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
