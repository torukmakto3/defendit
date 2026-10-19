import { mulberry32, seedFromString } from "./rng";
import type {
  ClaimGrade,
  DimensionScores,
  InterviewPlan,
  ModelGrade,
  Probe,
  ProbeType,
  QuestionDifficulty,
  UnderstandingBand,
} from "./types";

/** Graders this far apart on a 0–4 level are not averaged; the probe is disputed. */
export const DISAGREEMENT_LEVEL_SPREAD = 2;

const ALL_DIMS = ["accuracy", "reasoning", "transfer", "errorDetection", "ownership"] as const;
type Dim = (typeof ALL_DIMS)[number];

/** Planted-error items include whether the alteration was caught. Other items do not. */
export function scoredDimensions(type: ProbeType): readonly Dim[] {
  if (type === "planted_error") return ALL_DIMS;
  return ["accuracy", "reasoning", "transfer", "ownership"];
}

export function roundLevel(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(4, Math.round(n)));
}

export function bandFor(avg: number): UnderstandingBand {
  if (avg >= 3) return "Strong";
  if (avg >= 2) return "Partial";
  return "Weak";
}

/** 0–100 from the anchored levels that apply to this probe type. */
export function itemScore(scores: DimensionScores, type: ProbeType): number {
  const keys = scoredDimensions(type);
  const avg = keys.reduce((sum, key) => sum + scores[key], 0) / keys.length;
  return Math.round((avg / 4) * 100);
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightOf(probe: Probe): QuestionDifficulty {
  return probe.difficulty === 1 || probe.difficulty === 3 ? probe.difficulty : 2;
}

function gradeFor(grade: ModelGrade, probe: Probe, index: number): ClaimGrade | undefined {
  const byProbe = grade.claimGrades.find((c) => c.probeId === probe.id);
  if (byProbe) return byProbe;
  const byClaim = grade.claimGrades.filter((c) => c.claimId === probe.claimId && !c.probeId);
  if (byClaim.length === 1) return byClaim[0];
  return grade.claimGrades[index];
}

export interface ProbeScore {
  probeId: string;
  claimId: string;
  type: ProbeType;
  score: number;
  weight: number;
  spread: number;
  disputed: boolean;
  band: UnderstandingBand;
  median: DimensionScores;
}

export interface DefenseScore {
  /** Difficulty-weighted median. This is the receipt score. */
  score: number;
  probes: ProbeScore[];
  /** One score per probed claim, interview order, difficulty-weighted if asked twice. */
  claimScores: number[];
  disputedProbeIds: string[];
  bands: { strong: number; partial: number; weak: number };
}

function blankDims(): DimensionScores {
  return { accuracy: 0, reasoning: 0, transfer: 0, errorDetection: 0, ownership: 0 };
}

/**
 * Median of each anchored level across graders, then a difficulty-weighted
 * mean. A grader that omitted a probe is skipped for that probe. No default
 * middle score is invented.
 */
export function scoreDefense(grades: ModelGrade[], plan: InterviewPlan): DefenseScore {
  const probes: ProbeScore[] = plan.probes.map((probe, index) => {
    const rows = grades
      .map((g) => gradeFor(g, probe, index))
      .filter((c): c is ClaimGrade => !!c);
    const medianScores = blankDims();
    let spread = 0;
    for (const key of ALL_DIMS) {
      const values = rows.map((row) => roundLevel(row.scores?.[key] ?? 0));
      medianScores[key] = values.length ? median(values) : 0;
      if (values.length >= 2 && scoredDimensions(probe.type).includes(key)) {
        spread = Math.max(spread, Math.max(...values) - Math.min(...values));
      }
    }
    const avg =
      scoredDimensions(probe.type).reduce((sum, key) => sum + medianScores[key], 0) /
      scoredDimensions(probe.type).length;
    return {
      probeId: probe.id,
      claimId: probe.claimId,
      type: probe.type,
      score: itemScore(medianScores, probe.type),
      weight: weightOf(probe),
      spread,
      disputed: spread >= DISAGREEMENT_LEVEL_SPREAD,
      band: bandFor(avg),
      median: medianScores,
    };
  });

  const weightSum = probes.reduce((sum, p) => sum + p.weight, 0);
  const score = weightSum
    ? Math.round(probes.reduce((sum, p) => sum + p.score * p.weight, 0) / weightSum)
    : 0;

  const order = [...new Set(plan.probes.map((p) => p.claimId))];
  const claimScores = order.map((claimId) => {
    const rows = probes.filter((p) => p.claimId === claimId);
    const w = rows.reduce((sum, p) => sum + p.weight, 0);
    return w ? Math.round(rows.reduce((sum, p) => sum + p.score * p.weight, 0) / w) : 0;
  });

  const bands = { strong: 0, partial: 0, weak: 0 };
  for (const probe of probes) {
    if (probe.band === "Strong") bands.strong += 1;
    else if (probe.band === "Weak") bands.weak += 1;
    else bands.partial += 1;
  }

  return {
    score,
    probes,
    claimScores,
    disputedProbeIds: probes.filter((p) => p.disputed).map((p) => p.probeId),
    bands,
  };
}

/** One grader's difficulty-weighted score, ignoring any holistic overallScore. */
export function graderScore(grade: ModelGrade, plan: InterviewPlan): number {
  return scoreDefense([grade], plan).score;
}

/**
 * Previous receipt score: the mean of whatever overallScore the model typed.
 * A model that answered on the 0–4 rubric scale (observed in production as
 * 4/100) is taken at face value. Kept so calibration can compare.
 */
export function legacyAggregateScore(grades: ModelGrade[]): number {
  if (grades.length === 0) return 0;
  const avg = grades.reduce((sum, g) => sum + (Number.isFinite(g.overallScore) ? g.overallScore : 50), 0) / grades.length;
  return Math.round(Math.max(0, Math.min(100, avg)));
}

/**
 * An evidence string has to be a quote from the answer. Otherwise accuracy
 * and reasoning are capped at 1 so a fluent reason without a quote cannot
 * carry the item.
 */
export function groundEvidence(grade: ClaimGrade, answer: string): ClaimGrade {
  const evidence = (grade.evidence || "").replace(/\s+/g, " ").trim();
  const hay = answer.replace(/\s+/g, " ").toLowerCase();
  const needle = evidence.toLowerCase();
  const grounded = needle.length >= 8 && hay.includes(needle.slice(0, Math.min(needle.length, 80)));
  const scores: DimensionScores = {
    accuracy: roundLevel(grade.scores?.accuracy ?? 0),
    reasoning: roundLevel(grade.scores?.reasoning ?? 0),
    transfer: roundLevel(grade.scores?.transfer ?? 0),
    errorDetection: roundLevel(grade.scores?.errorDetection ?? 0),
    ownership: roundLevel(grade.scores?.ownership ?? 0),
  };
  if (grounded) return { ...grade, evidence, scores };
  return {
    ...grade,
    evidence: evidence ? `${evidence} (not in the answer)` : "(no quote from the answer)",
    scores: { ...scores, accuracy: Math.min(scores.accuracy, 1), reasoning: Math.min(scores.reasoning, 1) },
    reason: grade.reason || "No evidence quote from the answer.",
  };
}

export interface VarianceReport {
  mean: number;
  stdev: number;
  min: number;
  max: number;
  runs: number;
}

function summarize(values: number[]): VarianceReport {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return {
    mean: round1(mean),
    stdev: round1(Math.sqrt(variance)),
    min: Math.round(Math.min(...values)),
    max: Math.round(Math.max(...values)),
    runs: values.length,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const GOOD: DimensionScores = { accuracy: 3, reasoning: 3, transfer: 2, errorDetection: 2, ownership: 3 };
const BAD: DimensionScores = { accuracy: 1, reasoning: 1, transfer: 0, errorDetection: 1, ownership: 1 };

/**
 * Run-to-run stability of the old holistic mean versus the new median.
 *
 * Before: each grader samples levels with sd 0.55 (temperature above 0) and
 * types an independent overall score. With probability 0.25 that overall is a
 * 0–4 rubric integer mistaken for a percentage — the failure seen when a
 * substantive defense was receipted at 4/100.
 * After: temperature 0, so sampling sd is 0.2, levels are rounded to the
 * anchor, and the receipt uses the median. The holistic number is ignored.
 * One grader is an outlier (±2 levels) on 25% of runs; the median keeps that
 * single miss out of the receipt.
 */
export function simulateScoreVariance(opts?: { runs?: number; seed?: string; quality?: "good" | "bad" }): {
  before: VarianceReport;
  after: VarianceReport;
} {
  const runs = opts?.runs ?? 40;
  const quality = opts?.quality ?? "good";
  const truth = quality === "good" ? GOOD : BAD;
  const rand = mulberry32(seedFromString(opts?.seed ?? `calibrate-${quality}`));
  const before: number[] = [];
  const after: number[] = [];
  const dims = ALL_DIMS;

  for (let run = 0; run < runs; run++) {
    const grades: ModelGrade[] = [];
    for (let g = 0; g < 3; g++) {
      const scores = blankDims();
      for (const key of dims) {
        const sampled = truth[key] + gaussian(rand) * 0.55;
        scores[key] = Math.max(0, Math.min(4, sampled));
      }
      const fromDims = (dims.reduce((sum, key) => sum + scores[key], 0) / dims.length / 4) * 100;
      const mistakenScale = rand() < 0.25;
      const overallScore = mistakenScale
        ? Math.max(0, Math.min(4, Math.round(fromDims / 25)))
        : Math.max(0, Math.min(100, fromDims + gaussian(rand) * 8));
      grades.push({
        modelId: `g${g}`,
        provider: "sim",
        overallScore,
        claimGrades: [
          {
            probeId: "p1",
            claimId: "c1",
            section: "Thesis",
            scores,
            band: "Partial",
            evidence: "quoted evidence from the answer",
            reason: "sim",
          },
        ],
      });
    }
    before.push(legacyAggregateScore(grades));

    // One grader, not the whole council, occasionally misses by two levels.
    // The median should ignore that single miss.
    const outlierGrader = rand() < 0.25 ? Math.floor(rand() * 3) : -1;
    const outlierSign = rand() < 0.5 ? -2 : 2;
    const stable: ModelGrade[] = grades.map((grade, g) => {
      const scores = blankDims();
      const outlier = g === outlierGrader ? outlierSign : 0;
      for (const key of dims) {
        scores[key] = roundLevel(truth[key] + gaussian(rand) * 0.2 + outlier);
      }
      return {
        ...grade,
        claimGrades: [{ ...grade.claimGrades[0], scores }],
      };
    });
    const plan: InterviewPlan = {
      seed: "sim",
      difficulty: "standard",
      probes: [
        {
          id: "p1",
          claimId: "c1",
          type: "explain_back",
          difficulty: 2,
          question: "Explain the claim.",
          expectedFocus: "thesis",
        },
      ],
    };
    after.push(scoreDefense(stable, plan).score);
  }

  return { before: summarize(before), after: summarize(after) };
}

export interface TokenCost {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  frontierUsd: number;
  cheapUsd: number;
}

const FRONTIER_IN = 3;
const FRONTIER_OUT = 15;
const CHEAP_IN = 0.15;
const CHEAP_OUT = 0.6;

function cost(calls: number, inputTokens: number, outputTokens: number): TokenCost {
  const frontierUsd = (calls * inputTokens * FRONTIER_IN + calls * outputTokens * FRONTIER_OUT) / 1_000_000;
  const cheapUsd = (calls * inputTokens * CHEAP_IN + calls * outputTokens * CHEAP_OUT) / 1_000_000;
  return {
    calls,
    inputTokens: Math.round(calls * inputTokens),
    outputTokens: Math.round(calls * outputTokens),
    frontierUsd,
    cheapUsd,
  };
}

function add(parts: TokenCost[]): TokenCost {
  return parts.reduce(
    (sum, part) => ({
      calls: sum.calls + part.calls,
      inputTokens: sum.inputTokens + part.inputTokens,
      outputTokens: sum.outputTokens + part.outputTokens,
      frontierUsd: sum.frontierUsd + part.frontierUsd,
      cheapUsd: sum.cheapUsd + part.cheapUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, frontierUsd: 0, cheapUsd: 0 },
  );
}

/**
 * Planning estimate for one defense. Input sizes assume a ~2k-token document,
 * five learn turns, and a three-model council. Frontier prices are Sonnet-class
 * ($3 / $15 per MTok); cheap prices are mini-class ($0.15 / $0.60).
 * `followUpRate` is the share of defenses that spend a second grading round.
 */
export function estimateDefenseCost(opts: {
  documentTokens?: number;
  questions?: number;
  graders?: number;
  learnTurns?: number;
  followUpRate?: number;
  /** Before the rubric anchors and the claim map, prompts were shorter and grading ran once. */
  era: "before" | "after";
}): TokenCost {
  const doc = opts.documentTokens ?? 2000;
  const questions = opts.questions ?? 5;
  const graders = opts.graders ?? 3;
  const learnTurns = opts.learnTurns ?? 5;
  const followUpRate = opts.era === "before" ? 0 : (opts.followUpRate ?? 0.15);
  const extractOut = opts.era === "before" ? 700 : 1000;
  const gradeIn = opts.era === "before" ? 900 + questions * 120 : 1400 + questions * 140;
  const gradeOut = opts.era === "before" ? 500 + questions * 80 : 400 + questions * 90;
  const gradeRounds = 1 + followUpRate;
  // A failed question check is rewritten once. Most drafts pass; budget a quarter.
  const rewrites = opts.era === "before" ? 0 : 0.25;
  return add([
    cost(1, doc + 400, extractOut),
    cost(1, 600 + questions * 80, 80 * questions),
    cost(rewrites, 600 + questions * 80, 80 * questions),
    cost(learnTurns, doc / 2 + 500, 250),
    cost(graders * gradeRounds, gradeIn, gradeOut),
  ]);
}
