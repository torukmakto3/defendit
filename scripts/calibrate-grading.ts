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
import { calibrationAnswer, type CalibrationKind } from "../fixtures/calibration/answers";
import { extractClaims } from "../src/lib/claims";
import { gradeSession } from "../src/lib/grading";
import { getGradingCouncil, gradingCouncilProblem, scopeSettledUsd, withLlmScope } from "../src/lib/llm";
import { buildInterviewPlan } from "../src/lib/probes";
import {
  councilDimensionSpread,
  DISAGREEMENT_LEVEL_SPREAD,
  estimateDefenseCost,
  scoreDefense,
  simulateScoreVariance,
  transcriptLevels,
  type DimensionStat,
} from "../src/lib/score";
import type { Claim, DimensionScores, InterviewPlan, ModelGrade, TurnRecord } from "../src/lib/types";
import { DIMENSIONS } from "../src/lib/rubric";

const RUNS = Number(process.env.CALIBRATE_RUNS || "8");
const DIR = join(process.cwd(), "fixtures", "calibration");

function stdev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

const KINDS = ["good", "vague", "bad", "idk"] as const;

interface RunResult {
  receipt: number;
  byModel: { modelId: string; score: number }[];
  levels: DimensionScores;
  council: Record<(typeof DIMENSIONS)[number], DimensionStat>;
  disagreements: Record<(typeof DIMENSIONS)[number], number>;
  disputedProbes: number;
  durationsMs: number[];
  costUsd: number;
}

/** A live run must use at least two pinned models. A router (`*.auto`) is refused. */
function refuseUnpinnedLiveCouncil(): void {
  if (process.env.CALIBRATE_LIVE !== "1") return;
  const members = getGradingCouncil();
  const problem = gradingCouncilProblem(members);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Live council: ${members.map((member) => member.id).join(", ")}`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function levelDisagreements(grades: ModelGrade[], plan: InterviewPlan): {
  probes: number;
  byDim: Record<(typeof DIMENSIONS)[number], number>;
} {
  const byDim = Object.fromEntries(DIMENSIONS.map((key) => [key, 0])) as Record<
    (typeof DIMENSIONS)[number],
    number
  >;
  let probes = 0;
  for (const probe of plan.probes) {
    const rows = grades
      .map((grade) => grade.claimGrades.find((row) => row.probeId === probe.id))
      .filter((row): row is NonNullable<typeof row> => !!row);
    let disputed = false;
    for (const key of DIMENSIONS) {
      if (probe.type !== "planted_error" && key === "errorDetection") continue;
      const levels = rows.map((row) => Math.round(row.scores[key]));
      if (levels.length < 2) continue;
      if (Math.max(...levels) - Math.min(...levels) >= DISAGREEMENT_LEVEL_SPREAD) {
        byDim[key] += 1;
        disputed = true;
      }
    }
    if (disputed) probes += 1;
  }
  return { probes, byDim };
}

async function gradeOnce(fixture: string, claims: Claim[], kind: CalibrationKind, seed: string): Promise<RunResult> {
  const plan: InterviewPlan = buildInterviewPlan({ claims, difficulty: "standard", seed });
  const turns: TurnRecord[] = plan.probes.map((probe, i) => {
    const claim = claims.find((c) => c.id === probe.claimId);
    return {
      id: `turn_${i + 1}`,
      probeId: probe.id,
      question: probe.question,
      answer: calibrationAnswer({
        fixture,
        kind,
        claimText: claim?.text ?? "",
        probeType: probe.type,
        plantedContent: probe.plantedContent,
      }),
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1000).toISOString(),
      latencyMs: 1000,
      followUpIndex: 0,
    };
  });
  const durationsMs: number[] = [];
  const graded = await withLlmScope({}, async () => {
    const grades: ModelGrade[] = await gradeSession(
      { difficulty: "standard", claims, plan, turns },
      {
        onProgress: (progress) => {
          if (progress.durationMs !== undefined) durationsMs.push(progress.durationMs);
        },
      },
    );
    return { grades, costUsd: scopeSettledUsd() };
  });
  const gaps = levelDisagreements(graded.grades, plan);
  return {
    receipt: scoreDefense(graded.grades, plan).score,
    byModel: graded.grades.map((grade) => ({ modelId: grade.modelId, score: grade.overallScore })),
    levels: transcriptLevels(graded.grades, plan),
    council: councilDimensionSpread(graded.grades, plan),
    disagreements: gaps.byDim,
    disputedProbes: gaps.probes,
    durationsMs,
    costUsd: graded.costUsd,
  };
}

function modelLine(rows: { modelId: string; score: number }[]): string {
  const ids = [...new Set(rows.map((row) => row.modelId))];
  return ids
    .map((id) => {
      const scores = rows.filter((row) => row.modelId === id).map((row) => row.score);
      return `${id} mean ${avg(scores).toFixed(1)} (${Math.min(...scores)}-${Math.max(...scores)})`;
    })
    .join("; ");
}

function gapLine(rows: Record<(typeof DIMENSIONS)[number], number>[]): string {
  return DIMENSIONS.map((key) => {
    const total = rows.reduce((sum, row) => sum + row[key], 0);
    return `${key} ${total}`;
  }).join(", ");
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
  refuseUnpinnedLiveCouncil();
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
  console.log(`Calibration runs=${RUNS} files=${files.join(", ")} live=${process.env.CALIBRATE_LIVE === "1" ? "yes" : "no"}`);
  const pooled: Record<CalibrationKind, number[]> = { good: [], vague: [], bad: [], idk: [] };

  for (const file of files) {
    const text = readFileSync(join(DIR, file), "utf8");
    const extracted = await withLlmScope({}, async () => {
      const claims = await extractClaims(text);
      return { claims, usd: scopeSettledUsd() };
    });
    const bucket: Record<CalibrationKind, RunResult[]> = { good: [], vague: [], bad: [], idk: [] };
    for (let i = 0; i < RUNS; i++) {
      for (const kind of KINDS) {
        bucket[kind].push(await gradeOnce(file, extracted.claims, kind, `${file}-${kind}`));
      }
    }
    for (const kind of KINDS) pooled[kind].push(...bucket[kind].map((row) => row.receipt));
    const good = bucket.good.map((row) => row.receipt);
    const vague = bucket.vague.map((row) => row.receipt);
    const bad = bucket.bad.map((row) => row.receipt);
    const idk = bucket.idk.map((row) => row.receipt);
    const durations = bucket.good.flatMap((row) => row.durationsMs);
    const goodCost = bucket.good.map((row) => row.costUsd);
    console.log(
      `  ${file}: claims ${extracted.claims.length} extracted once (${money(extracted.usd)}). good mean ${avg(good).toFixed(1)} stdev ${stdev(good).toFixed(2)} (range ${Math.min(...good)}-${Math.max(...good)}, target >=80). vague mean ${avg(vague).toFixed(1)} stdev ${stdev(vague).toFixed(2)} (range ${Math.min(...vague)}-${Math.max(...vague)}, target <=30). bad "I guess it's fine." mean ${avg(bad).toFixed(2)}. "I don't know." mean ${avg(idk).toFixed(2)}.`,
    );
    console.log(`    dimensions across ${RUNS} good runs: ${formatDims(spreadAcross(bucket.good.map((row) => row.levels)))}`);
    console.log(`    council spread on one good run: ${formatDims(bucket.good[0].council)}`);
    console.log(`    per-model good: ${modelLine(bucket.good.flatMap((row) => row.byModel))}`);
    console.log(`    per-model vague: ${modelLine(bucket.vague.flatMap((row) => row.byModel))}`);
    console.log(
      `    disagreements of ${DISAGREEMENT_LEVEL_SPREAD}+ levels on good: ${avg(bucket.good.map((row) => row.disputedProbes)).toFixed(1)} probes/defense; ${gapLine(bucket.good.map((row) => row.disagreements))}`,
    );
    console.log(
      `    latency p50 ${percentile(durations, 50).toFixed(0)}ms p90 ${percentile(durations, 90).toFixed(0)}ms (n=${durations.length}). cost per good defense mean ${money(avg(goodCost))}.`,
    );
  }

  console.log(
    `Measured run-to-run (same answer, ${RUNS} runs, per file above): authored good answers sit near ${avg(pooled.good).toFixed(1)} (target >=80). Pooled stdev across files is ${stdev(pooled.good).toFixed(2)} because the three documents score a few points apart, not because a rerun moves. Vague mean ${avg(pooled.vague).toFixed(1)} (target <=30). Known-bad mean ${avg(pooled.bad).toFixed(2)}. All "I don't know." mean ${avg(pooled.idk).toFixed(2)}.`,
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
