import { completeJson, getGradingCouncil } from "./llm";
import { RUBRIC_VERSION, rubricPrompt } from "./rubric";
import type {
  Claim,
  ClaimGrade,
  Difficulty,
  InterviewPlan,
  ModelGrade,
  TurnRecord,
} from "./types";

export { RUBRIC_VERSION };

interface GradeJson {
  claimGrades: ClaimGrade[];
  overallScore: number;
}

export async function gradeSession(opts: {
  difficulty: Difficulty;
  claims: Claim[];
  plan: InterviewPlan;
  turns: TurnRecord[];
}): Promise<ModelGrade[]> {
  const council = getGradingCouncil();
  const transcript = buildTranscript(opts.claims, opts.plan, opts.turns);

  // Members grade in parallel; a defense survives one member failing as long
  // as a majority returns a grade.
  const settled = await Promise.allSettled(
    council.map(async (model): Promise<ModelGrade> => {
      const { data, raw } = await completeJson<GradeJson>(model, {
        purpose: "grade",
        temperature: 0.1,
        messages: [
          { role: "system", content: rubricPrompt(opts.difficulty) },
          {
            role: "user",
            content: `Grade this defense transcript.\n\n<transcript>\n${transcript}\n</transcript>`,
          },
        ],
      });
      return {
        modelId: raw.modelId,
        provider: raw.provider,
        claimGrades: normalizeClaimGrades(data.claimGrades, opts.claims),
        overallScore: clampScore(data.overallScore),
      };
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

/**
 * Per-claim score (0-100), averaged across the council, in the order the
 * claims were probed. Dimensions are 0-4 each.
 */
export function claimScores(grades: ModelGrade[], plan: InterviewPlan): number[] {
  const order = [...new Set(plan.probes.map((p) => p.claimId))];
  return order
    .map((claimId) => {
      const vals = grades
        .map((g) => g.claimGrades.find((c) => c.claimId === claimId))
        .filter((c): c is ClaimGrade => !!c)
        .map((c) => {
          const dims = Object.values(c.scores);
          return dims.reduce((a, b) => a + b, 0) / (dims.length * 4);
        });
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) : null;
    })
    .filter((v): v is number => v !== null);
}

export function aggregateScore(grades: ModelGrade[]): number {
  if (grades.length === 0) return 0;
  const avg =
    grades.reduce((s, g) => s + g.overallScore, 0) / grades.length;
  return Math.round(avg);
}

function buildTranscript(
  claims: Claim[],
  plan: InterviewPlan,
  turns: TurnRecord[],
): string {
  return turns
    .map((t) => {
      const probe = plan.probes.find((p) => p.id === t.probeId);
      const claim = claims.find((c) => c.id === probe?.claimId);
      return [
        `Claim id: ${claim?.id ?? "unknown"}`,
        `Section: ${claim?.section ?? "General"}`,
        `Probe type: ${probe?.type ?? "unknown"}`,
        `Question: ${t.question}`,
        `Answer: ${neutralizeTags(t.answer)}`,
        `Latency ms: ${t.latencyMs}`,
      ].join("\n");
    })
    .join("\n\n");
}

/** Stop an answer from closing the transcript block early. */
function neutralizeTags(text: string): string {
  return text.replace(/<\/?transcript>/gi, "[tag removed]");
}

function normalizeClaimGrades(
  grades: ClaimGrade[] | undefined,
  claims: Claim[],
): ClaimGrade[] {
  if (!grades?.length) {
    return claims.slice(0, 3).map((c) => ({
      claimId: c.id,
      section: c.section,
      scores: {
        accuracy: 2,
        reasoning: 2,
        transfer: 2,
        errorDetection: 2,
        ownership: 2,
      },
      band: "Partial" as const,
      evidence: "",
      reason: "No grade returned; defaulted.",
    }));
  }
  return grades;
}

function clampScore(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function shouldFlagForHuman(grades: ModelGrade[]): boolean {
  if (grades.length < 2) return false;
  const sorted = [...grades].sort((a, b) => a.overallScore - b.overallScore);
  return sorted[sorted.length - 1].overallScore - sorted[0].overallScore > 20;
}
