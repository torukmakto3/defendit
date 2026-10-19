import { z } from "zod";
import { completeJson, getGradingCouncil } from "./llm";
import { detectNonAnswer } from "./non-answer";
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

export async function gradeSession(opts: {
  difficulty: Difficulty;
  claims: Claim[];
  plan: InterviewPlan;
  turns: TurnRecord[];
}): Promise<ModelGrade[]> {
  const council = getGradingCouncil();
  const transcript = buildTranscript(opts.claims, opts.plan, opts.turns);

  const settled = await Promise.allSettled(
    council.map(async (model): Promise<ModelGrade> => {
      const { data, raw } = await completeJson(model, {
        purpose: "grade",
        temperature: 0,
        messages: [
          { role: "system", content: rubricPrompt(opts.difficulty) },
          {
            role: "user",
            content: `Grade each answer against its claim. Quote the answer in evidence.\n\n<transcript>\n${transcript}\n</transcript>`,
          },
        ],
      }, gradeResponseSchema);
      const claimGrades = alignGrades(data.claimGrades, opts.plan, opts.turns, opts.claims);
      const covered = claimGrades.length;
      if (covered < Math.ceil(opts.plan.probes.length / 2)) {
        throw new Error("Grader omitted too many answers");
      }
      const grade: ModelGrade = {
        modelId: raw.modelId,
        provider: raw.provider,
        claimGrades,
        overallScore: 0,
      };
      grade.overallScore = graderScore(grade, opts.plan);
      return grade;
    }),
  );
  const grades = settled
    .filter((r): r is PromiseFulfilledResult<ModelGrade> => r.status === "fulfilled")
    .map((r) => r.value);
  const needed = Math.floor(council.length / 2) + 1;
  if (grades.length < needed) {
    const first = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw first?.reason instanceof Error ? first.reason : new Error("Grading failed");
  }
  return grades;
}

/** Per-claim score (0-100) from the median rubric, in interview order. */
export function claimScores(grades: ModelGrade[], plan: InterviewPlan): number[] {
  return scoreDefense(grades, plan).claimScores;
}

export function aggregateScore(grades: ModelGrade[], plan?: InterviewPlan): number {
  if (plan && grades.some((g) => g.claimGrades.length > 0)) return scoreDefense(grades, plan).score;
  return legacyAggregateScore(grades);
}

function buildTranscript(claims: Claim[], plan: InterviewPlan, turns: TurnRecord[]): string {
  return turns
    .map((turn) => {
      const probe = plan.probes.find((p) => p.id === turn.probeId);
      const claim = claims.find((c) => c.id === probe?.claimId);
      return [
        `Probe id: ${probe?.id ?? turn.probeId}`,
        `Claim id: ${claim?.id ?? "unknown"}`,
        `Probe type: ${probe?.type ?? "unknown"}`,
        `Difficulty: ${probe?.difficulty ?? 2}`,
        `Section: ${claim?.section ?? "General"}`,
        `Claim: ${neutralizeTags(claim?.text ?? "")}`,
        `Source: ${neutralizeTags(claim?.sourceSpan ?? "")}`,
        `Figures: ${(claim?.figures ?? []).join(", ") || "none"}`,
        `Question: ${neutralizeTags(turn.question)}`,
        `Answer: ${neutralizeTags(turn.answer)}`,
        `Latency ms: ${turn.latencyMs}`,
      ].join("\n");
    })
    .join("\n\n");
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
        reason: `Non-answer (${nonAnswer.kind}): no substantive engagement with the claim.`,
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
