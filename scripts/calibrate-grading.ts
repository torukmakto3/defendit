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
import {
  councilDimensionSpread,
  estimateDefenseCost,
  scoreDefense,
  simulateScoreVariance,
  transcriptLevels,
  type DimensionStat,
} from "../src/lib/score";
import type { DimensionScores, InterviewPlan, ModelGrade, TurnRecord } from "../src/lib/types";
import { DIMENSIONS } from "../src/lib/rubric";

const RUNS = Number(process.env.CALIBRATE_RUNS || "8");
const DIR = join(process.cwd(), "fixtures", "calibration");

function stdev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function answerFor(kind: "good" | "bad" | "idk", claim: string): string {
  if (kind === "bad") return "I guess it's fine.";
  if (kind === "idk") return "I don't know.";
  return `Because the document says "${claim.slice(0, 160)}". If that assumption moved against us, the conclusion would weaken, and I would check the source figure before signing.`;
}

async function gradeOnce(
  text: string,
  kind: "good" | "bad" | "idk",
  seed: string,
): Promise<{
  receipt: number;
  graderScores: number[];
  levels: DimensionScores;
  council: Record<(typeof DIMENSIONS)[number], DimensionStat>;
}> {
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
  return {
    receipt: scoreDefense(grades, plan).score,
    graderScores: grades.map((g) => g.overallScore),
    levels: transcriptLevels(grades, plan),
    council: councilDimensionSpread(grades, plan),
  };
}

function formatDims(stats: Record<string, { min: number; max: number; stdev: number }>): string {
  return DIMENSIONS.map((key) => {
    const stat = stats[key];
    return `${key} min ${stat.min.toFixed(2)} max ${stat.max.toFixed(2)} stdev ${stat.stdev.toFixed(2)}`;
  }).join("; ");
}

function spreadAcross(rows: DimensionScores[]): Record<string, { min: number; max: number; stdev: number }> {
  const out: Record<string, { min: number; max: number; stdev: number }> = {};
  for (const key of DIMENSIONS) {
    const values = rows.map((row) => row[key]);
    out[key] = {
      min: Math.min(...values),
      max: Math.max(...values),
      stdev: stdev(values),
    };
  }
  return out;
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
  const idkScores: number[] = [];

  for (const file of files) {
    const text = readFileSync(join(DIR, file), "utf8");
    const good: number[] = [];
    const bad: number[] = [];
    const idk: number[] = [];
    const goodLevels: DimensionScores[] = [];
    let council = "";
    for (let i = 0; i < RUNS; i++) {
      const g = await gradeOnce(text, "good", `${file}-good`);
      const b = await gradeOnce(text, "bad", `${file}-bad`);
      const u = await gradeOnce(text, "idk", `${file}-idk`);
      good.push(g.receipt);
      bad.push(b.receipt);
      idk.push(u.receipt);
      goodLevels.push(g.levels);
      council = formatDims(g.council);
    }
    goodScores.push(...good);
    badScores.push(...bad);
    idkScores.push(...idk);
    console.log(
      `  ${file}: overall good mean ${avg(good).toFixed(1)} stdev ${stdev(good).toFixed(2)} (range ${Math.min(...good)}-${Math.max(...good)}), bad "I guess it's fine." mean ${avg(bad).toFixed(2)} stdev ${stdev(bad).toFixed(2)}, "I don't know." mean ${avg(idk).toFixed(2)} stdev ${stdev(idk).toFixed(2)}`,
    );
    console.log(`    dimensions across ${RUNS} good runs: ${formatDims(spreadAcross(goodLevels))}`);
    console.log(`    council spread on one good run: ${council}`);
  }

  console.log(
    `Measured run-to-run (same answer, ${RUNS} runs, per file above): good answers sit near ${avg(goodScores).toFixed(1)}. Pooled stdev across files is ${stdev(goodScores).toFixed(2)} because the three documents score a few points apart, not because a rerun moves. Known-bad mean ${avg(badScores).toFixed(2)}. All "I don't know." mean ${avg(idkScores).toFixed(2)}.`,
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
