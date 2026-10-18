import { completeJson, getGradingCouncil } from "./llm";
import { RUBRIC_VERSION, rubricPrompt } from "./rubric";
import type {
  Claim,
  ClaimGrade,
  Difficulty,
  InterviewPlan,
  ModelGrade,
  TurnRecord,
  UnderstandingBand,
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

  const grades: ModelGrade[] = [];
  for (const model of council) {
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

    grades.push({
      modelId: raw.modelId,
      provider: raw.provider,
      claimGrades: normalizeClaimGrades(data.claimGrades, opts.claims),
      overallScore: clampScore(data.overallScore),
    });
  }
  return grades;
}

export function aggregateScore(grades: ModelGrade[]): number {
  if (grades.length === 0) return 0;
  const avg =
    grades.reduce((s, g) => s + g.overallScore, 0) / grades.length;
  return Math.round(avg);
}

export function bandSummary(
  grades: ModelGrade[],
  claims: Claim[],
): { section: string; band: UnderstandingBand }[] {
  const bySection = new Map<string, number[]>();
  for (const g of grades) {
    for (const cg of g.claimGrades) {
      const claim = claims.find((c) => c.id === cg.claimId);
      const section = cg.section || claim?.section || "General";
      const avg =
        Object.values(cg.scores).reduce((a, b) => a + b, 0) /
        Object.values(cg.scores).length;
      const list = bySection.get(section) || [];
      list.push(avg);
      bySection.set(section, list);
    }
  }
  return [...bySection.entries()].map(([section, vals]) => {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const band: UnderstandingBand =
      avg >= 3 ? "Strong" : avg >= 2 ? "Partial" : "Weak";
    return { section, band };
  });
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
