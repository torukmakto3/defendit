import { z } from "zod";
import type { GradingProgress } from "./grading-progress";
import {
  completeJson,
  forceNextGrade,
  getGradingCouncil,
  getTrackedCheapestLlm,
  graderTimeoutMs,
  GRADING_TEMPERATURE,
  gradingSeed,
  LlmBudgetError,
} from "./llm";
import { detectNonAnswer } from "./non-answer";
import { languageInstruction, resolveDocumentLanguage } from "./language";
import { RUBRIC_VERSION, rubricPrompt } from "./rubric";
import {
  graderScore,
  groundEvidence,
  legacyAggregateScore,
  roundLevel,
  scoreDefense,
  type DefenseScore,
} from "./score";
import type { Claim, ClaimGrade, Difficulty, DimensionScores, InterviewPlan, ModelGrade, Probe, TurnRecord } from "./types";

export { RUBRIC_VERSION };
export { graderTimeoutMs };

/** Leave this much of the defend route after a late cheap grader, for signing. */
export const BUDGET_FALLBACK_MARGIN_MS = 10_000;

/**
 * The budget-fallback grader does not get a fresh full timeout. It stops
 * this far before `deadlineMs`, and never longer than the normal grader timeout.
 */
export function budgetFallbackTimeoutMs(deadlineMs: number, now = Date.now()): number {
  const remain = deadlineMs - now - BUDGET_FALLBACK_MARGIN_MS;
  return Math.max(0, Math.min(graderTimeoutMs(), Math.floor(remain)));
}

export { legacyAggregateScore, scoreDefense, type DefenseScore };

const level = z.coerce.number();

const gradeResponseSchema = z.object({
  claimGrades: z
    .array(
      z.object({
        probeId: z.string().optional(),
        claimId: z.string().optional(),
        section: z.string().optional(),
        scores: z.object({
          accuracy: level,
          reasoning: level,
          transfer: level,
          errorDetection: level,
          ownership: level,
        }),
        band: z.enum(["Weak", "Partial", "Strong"]).optional(),
        evidence: z.string().optional().default(""),
        reason: z.string().optional().default(""),
      }),
    )
    .min(1),
  overallScore: z.coerce.number().optional(),
});

export interface GraderProgress extends GradingProgress {
  modelId?: string;
  durationMs?: number;
}

/**
 * Grade with the council in parallel. Each member has its own timeout.
 * A member that times out is dropped; a majority of the council is still required.
 * Token accounting is not done here: the caller flushes it after this returns.
 */
export async function gradeSession(
  opts: {
    difficulty: Difficulty;
    claims: Claim[];
    plan: InterviewPlan;
    turns: TurnRecord[];
    /** Absolute time the defend route must finish. Caps only the budget-fallback grader. */
    deadlineMs?: number;
    /** Document language. Missing stays English, including sessions stored before the column. */
    language?: string | null;
  },
  hooks?: {
    onProgress?: (progress: GraderProgress) => void | Promise<void>;
  },
): Promise<ModelGrade[]> {
  const council = getGradingCouncil();
  const timeout = graderTimeoutMs();
  let settledCount = 0;
  // Progress writes stay in order and off each grader's clock.
  let progressChain = Promise.resolve();
  const report = (progress: GraderProgress) => {
    progressChain = progressChain.then(() => notify(hooks, progress));
  };

  const skipped = gradesForAllNonAnswers(opts);
  if (skipped) {
    report({ done: 1, total: 1, stage: "grading", modelId: skipped[0].modelId });
    await progressChain;
    return skipped;
  }

  const transcript = buildTranscript(opts.claims, opts.plan, opts.turns, opts.language);
  report({ done: 0, total: council.length, stage: "grading" });

  const settled = await Promise.allSettled(
    council.map(async (model) => {
      const started = Date.now();
      try {
        const grade = await gradeWithTimeout(model, opts, transcript, timeout);
        settledCount += 1;
        report({
          done: settledCount,
          total: council.length,
          stage: "grading",
          modelId: grade.modelId,
          durationMs: Date.now() - started,
        });
        return { grade, budget: false };
      } catch (error) {
        settledCount += 1;
        report({
          done: settledCount,
          total: council.length,
          stage: "grading",
          modelId: model.id,
          durationMs: Date.now() - started,
        });
        if (error instanceof LlmBudgetError) return { grade: null, budget: true };
        throw error;
      }
    }),
  );
  await progressChain;
  const grades = settled
    .filter((r): r is PromiseFulfilledResult<{ grade: ModelGrade | null; budget: boolean }> => r.status === "fulfilled")
    .map((r) => r.value.grade)
    .filter((grade): grade is ModelGrade => grade !== null);
  const budgetSkips = settled.filter(
    (r) => r.status === "fulfilled" && r.value.budget,
  ).length;
  const needed = Math.floor(council.length / 2) + 1;
  if (grades.length >= needed) return grades;
  // The cap dropped members. Finish with the grades that fit, or one cheap grader
  // when nothing has been scored yet, so the defense still gets a receipt.
  if (grades.length >= 1 && budgetSkips > 0) return grades;
  if (grades.length === 0 && budgetSkips > 0) {
    forceNextGrade();
    const started = Date.now();
    const model = getTrackedCheapestLlm();
    const fallbackTimeout =
      opts.deadlineMs === undefined ? timeout : budgetFallbackTimeoutMs(opts.deadlineMs);
    try {
      if (fallbackTimeout <= 0) {
        throw new Error(`Grader ${model.id} timed out after ${fallbackTimeout}ms`);
      }
      return [await gradeWithTimeout(model, opts, transcript, fallbackTimeout)];
    } catch (error) {
      report({
        done: council.length,
        total: council.length,
        stage: "grading",
        modelId: model.id,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }
  const first = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  throw first?.reason instanceof Error ? first.reason : new Error("Grading failed");
}

async function notify(
  hooks: { onProgress?: (progress: GraderProgress) => void | Promise<void> } | undefined,
  progress: GraderProgress,
): Promise<void> {
  try {
    await hooks?.onProgress?.(progress);
  } catch (e) {
    console.error("[grading] progress", e instanceof Error ? e.message : e);
  }
}

/** Bound one grader so a hung model cannot hold the other two. */
async function gradeWithTimeout(
  model: ReturnType<typeof getGradingCouncil>[number],
  opts: { difficulty: Difficulty; claims: Claim[]; plan: InterviewPlan; turns: TurnRecord[]; language?: string | null },
  transcript: string,
  timeout: number,
): Promise<ModelGrade> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`Grader ${model.id} timed out after ${timeout}ms`));
    }, timeout);
  });
  try {
    return await Promise.race([gradeOne(model, opts, transcript, ac.signal), timed]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Per-claim score (0-100) from the median rubric, in interview order. */
export function claimScores(grades: ModelGrade[], plan: InterviewPlan): number[] {
  return scoreDefense(grades, plan).claimScores;
}

export function aggregateScore(grades: ModelGrade[], plan?: InterviewPlan): number {
  if (plan && grades.some((g) => g.claimGrades.length > 0)) return scoreDefense(grades, plan).score;
  return legacyAggregateScore(grades);
}

function buildTranscript(claims: Claim[], plan: InterviewPlan, turns: TurnRecord[], language?: string | null): string {
  const code = resolveDocumentLanguage(language);
  const blocks = turns
    .map((turn) => {
      const probe = plan.probes.find((p) => p.id === turn.probeId);
      const claim = claims.find((c) => c.id === probe?.claimId);
      const cited = probe?.sourceSpan || claim?.sourceSpan || "";
      return [
        `Probe id: ${probe?.id ?? turn.probeId}`,
        `Claim id: ${claim?.id ?? "unknown"}`,
        `Probe type: ${probe?.type ?? "unknown"}`,
        `Difficulty: ${probe?.difficulty ?? 2}`,
        `Section: ${claim?.section ?? "General"}`,
        `Claim: ${neutralizeTags(claim?.text ?? "")}`,
        `Source: ${neutralizeTags(claim?.sourceSpan ?? "")}`,
        `Cited span (full): ${neutralizeTags(cited)}`,
        `Planted excerpt (full): ${neutralizeTags(probe?.plantedContent || "none")}`,
        `Figures: ${(claim?.figures ?? []).join(", ") || "none"}`,
        `Question: ${neutralizeTags(turn.question)}`,
        `Answer: ${neutralizeTags(turn.answer)}`,
      ].join("\n");
    })
    .join("\n\n");
  return `Document language: ${code}\n\n${blocks}`;
}

/** Stop an answer from closing the transcript block early. */
function neutralizeTags(text: string): string {
  return text.replace(/<\/?transcript>/gi, "[tag removed]");
}

const ZERO_SCORES: DimensionScores = {
  accuracy: 0,
  reasoning: 0,
  transfer: 0,
  errorDetection: 0,
  ownership: 0,
};

function nonAnswerReason(kind: string): string {
  return `Non-answer (${kind}): no substantive engagement with the claim.`;
}

/**
 * When every recorded answer is a non-answer, the council is not called.
 * One rule grade scores each probe at zero. It is not labeled as a model.
 */
function gradesForAllNonAnswers(opts: {
  claims: Claim[];
  plan: InterviewPlan;
  turns: TurnRecord[];
}): ModelGrade[] | null {
  if (opts.turns.length === 0 || opts.plan.probes.length === 0) return null;
  if (opts.turns.some((turn) => !opts.plan.probes.some((probe) => probe.id === turn.probeId))) return null;
  const rows: ClaimGrade[] = [];
  for (const probe of opts.plan.probes) {
    const turn = opts.turns.find((t) => t.probeId === probe.id);
    if (!turn) return null;
    const claim = opts.claims.find((c) => c.id === probe.claimId);
    const nonAnswer = detectNonAnswer({
      answer: turn.answer,
      question: turn.question,
      claimText: claim?.text ?? "",
      sourceSpan: probe.sourceSpan || claim?.sourceSpan || "",
      figures: claim?.figures ?? [],
      probeType: probe.type,
    });
    if (!nonAnswer) return null;
    rows.push({
      probeId: probe.id,
      claimId: probe.claimId,
      section: claim?.section || "General",
      scores: { ...ZERO_SCORES },
      band: "Weak",
      evidence: "",
      reason: nonAnswerReason(nonAnswer.kind),
    });
  }
  const grade: ModelGrade = {
    modelId: "non-answer",
    provider: "rule",
    claimGrades: rows,
    overallScore: 0,
  };
  grade.overallScore = graderScore(grade, opts.plan);
  return [grade];
}

function alignGrades(
  grades: z.infer<typeof gradeResponseSchema>["claimGrades"],
  plan: InterviewPlan,
  turns: TurnRecord[],
  claims: Claim[],
): ClaimGrade[] {
  const used = new Set<number>();
  const aligned: ClaimGrade[] = [];
  for (const [index, probe] of plan.probes.entries()) {
    const turn = turns.find((t) => t.probeId === probe.id);
    if (!turn) continue;
    const claim = claims.find((c) => c.id === probe.claimId);
    const match = matchGrade(grades, probe, index, used);
    const nonAnswer = detectNonAnswer({
      answer: turn.answer,
      question: turn.question,
      claimText: claim?.text ?? "",
      sourceSpan: probe.sourceSpan || claim?.sourceSpan || "",
      figures: claim?.figures ?? [],
      probeType: probe.type,
    });
    if (nonAnswer) {
      if (match !== undefined) used.add(match);
      aligned.push({
        probeId: probe.id,
        claimId: probe.claimId,
        section: claim?.section || "General",
        scores: { ...ZERO_SCORES },
        band: "Weak",
        evidence: "",
        reason: nonAnswerReason(nonAnswer.kind),
      });
      continue;
    }
    if (match === undefined) continue;
    used.add(match);
    const raw = grades[match];
    const grounded = groundEvidence(
      {
        probeId: probe.id,
        claimId: probe.claimId,
        section: raw.section || claim?.section || "General",
        scores: raw.scores as DimensionScores,
        band: raw.band ?? "Partial",
        evidence: raw.evidence,
        reason: raw.reason,
      },
      turn.answer,
    );
    const dims = grounded.scores;
    const avg = (["accuracy", "reasoning", "transfer", "ownership"] as const).reduce((s, k) => s + dims[k], 0) / 4;
    aligned.push({
      ...grounded,
      scores: {
        accuracy: roundLevel(dims.accuracy),
        reasoning: roundLevel(dims.reasoning),
        transfer: roundLevel(dims.transfer),
        errorDetection: roundLevel(dims.errorDetection),
        ownership: roundLevel(dims.ownership),
      },
      band: avg >= 3 ? "Strong" : avg >= 2 ? "Partial" : "Weak",
    });
  }
  return aligned;
}

/** 503 overloaded and a transient 404 model_not_found are worth one more try. */
export function isRetryableGraderError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof LlmBudgetError) return false;
  const status = error.message.match(/\berror (\d{3})\b/);
  if (!status) return false;
  if (status[1] === "503" && /overloaded/i.test(error.message)) return true;
  if (status[1] === "404" && /model_not_found/i.test(error.message)) return true;
  return false;
}

/** Short wait before the one retry. `GRADER_RETRY_BASE_MS` and `GRADER_RETRY_JITTER_MS` override it. */
export function graderRetryDelayMs(rand: () => number = Math.random): number {
  const base = readNonNegativeMs(process.env.GRADER_RETRY_BASE_MS, 250);
  const jitter = readNonNegativeMs(process.env.GRADER_RETRY_JITTER_MS, 500);
  return Math.round(base + rand() * jitter);
}

function readNonNegativeMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function waitForGraderRetry(signal: AbortSignal | undefined, modelId: string): Promise<void> {
  const ms = graderRetryDelayMs();
  const timedOut = () => new Error(`Grader ${modelId} timed out after ${graderTimeoutMs()}ms`);
  if (signal?.aborted) return Promise.reject(timedOut());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer);
      reject(timedOut());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", fail);
      resolve();
    }, ms);
    signal?.addEventListener("abort", fail, { once: true });
  });
}

/**
 * One grader call, plus a single retry when the host is overloaded or cannot
 * find the model yet. The retry is another `completeJson`, so the per-defense
 * cost cap reserves it the same way as the first attempt. A cap refusal is
 * not retried again.
 */
async function completeGradeCall(
  model: ReturnType<typeof getGradingCouncil>[number],
  opts: { difficulty: Difficulty; language?: string | null },
  transcript: string,
  signal?: AbortSignal,
) {
  const temperature = GRADING_TEMPERATURE;
  const seed = gradingSeed();
  const run = () =>
    completeJson(
      model,
      {
        purpose: "grade",
        temperature,
        seed,
        signal,
        messages: [
          { role: "system", content: rubricPrompt(opts.difficulty, opts.language) },
          {
            role: "user",
            content: [
              languageInstruction(opts.language),
              "Grade each answer against its claim. Grade against the full cited span and the full planted excerpt in the transcript, not against a shortened quotation inside the question.",
              "An answer in the document language or in English is equally acceptable. Do not penalize the language.",
              "Write each reason in the document language. Quote the answer in evidence.",
              "",
              `<transcript>\n${transcript}\n</transcript>`,
            ].join("\n"),
          },
        ],
      },
      gradeResponseSchema,
    );
  try {
    return await run();
  } catch (error) {
    if (!isRetryableGraderError(error)) throw error;
    await waitForGraderRetry(signal, model.id);
    return await run();
  }
}

/** One council member. A skipped question is asked again once, then the grader is dropped. */
async function gradeOne(
  model: ReturnType<typeof getGradingCouncil>[number],
  opts: { difficulty: Difficulty; claims: Claim[]; plan: InterviewPlan; turns: TurnRecord[]; language?: string | null },
  transcript: string,
  signal?: AbortSignal,
): Promise<ModelGrade> {
  const temperature = GRADING_TEMPERATURE;
  const seed = gradingSeed();
  let last = "Grader skipped a question";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error(`Grader ${model.id} timed out after ${graderTimeoutMs()}ms`);
    const { data, raw } = await completeGradeCall(model, opts, transcript, signal);
    const claimGrades = alignGrades(data.claimGrades, opts.plan, opts.turns, opts.claims);
    const answered = opts.plan.probes.filter((probe) => opts.turns.some((turn) => turn.probeId === probe.id));
    const covered = new Set(claimGrades.map((grade) => grade.probeId));
    if (answered.every((probe) => covered.has(probe.id))) {
      const grade: ModelGrade = {
        modelId: raw.modelId,
        provider: raw.provider,
        temperature,
        seed,
        ...(raw.budgetFallback ? { budgetFallback: true as const } : {}),
        claimGrades,
        overallScore: 0,
      };
      grade.overallScore = graderScore(grade, opts.plan);
      return grade;
    }
    last = `Grader ${model.id} skipped a question`;
  }
  throw new Error(last);
}

function matchGrade(
  grades: { probeId?: string; claimId?: string }[],
  probe: Probe,
  index: number,
  used: Set<number>,
): number | undefined {
  const byProbe = grades.findIndex((g, i) => !used.has(i) && g.probeId === probe.id);
  if (byProbe >= 0) return byProbe;
  const byClaim = grades.findIndex((g, i) => !used.has(i) && !g.probeId && g.claimId === probe.claimId);
  if (byClaim >= 0) return byClaim;
  if (!used.has(index) && grades[index]) return index;
  return undefined;
}

export function shouldFlagForHuman(grades: ModelGrade[], plan?: InterviewPlan): boolean {
  if (plan) return scoreDefense(grades, plan).disputedProbeIds.length > 0;
  if (grades.length < 2) return false;
  const sorted = [...grades].sort((a, b) => a.overallScore - b.overallScore);
  return sorted[sorted.length - 1].overallScore - sorted[0].overallScore > 20;
}
