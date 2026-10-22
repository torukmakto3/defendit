import { PARTIAL_CLAIM_SCORE, STRONG_CLAIM_SCORE } from "@/lib/score-bands";
import type { ReceiptPayload } from "@/lib/types";

/**
 * Footer line for a receipt. New receipts name each grader's temperature and
 * seed. Older receipts only have model ids, and keep the model-only line.
 */
export function gradedWithLine(p: Pick<ReceiptPayload, "graders" | "modelVersions" | "rubricVersion">): string {
  const models = p.graders?.length
    ? p.graders
        .map((g) => {
          const fallback = g.budgetFallback ? ", budget fallback" : "";
          return `${g.model} (temperature ${g.temperature}, seed ${g.seed}${fallback})`;
        })
        .join(", ")
    : p.modelVersions.join(", ");
  return `Graded with ${models} · ${p.rubricVersion}`;
}

export type Band = "strong" | "partial" | "weak";
export interface ClaimResult {
  label: string;
  score: number;
  band: Band;
}

/** Bands use the rubric's thresholds: strong at STRONG_CLAIM_SCORE, partial at PARTIAL_CLAIM_SCORE, weak below. */
export function bandOf(score: number): Band {
  return score >= STRONG_CLAIM_SCORE ? "strong" : score >= PARTIAL_CLAIM_SCORE ? "partial" : "weak";
}

/**
 * Per-claim results for the charts. Receipts carry anonymous scores; older
 * receipts only have band counts, so those are spread into representative
 * scores and marked approximate.
 */
export function claimResults(p: ReceiptPayload, labels?: string[] | null): { claims: ClaimResult[]; approximate: boolean } {
  const name = (i: number) => labels?.[i] ?? `Claim ${String(i + 1).padStart(2, "0")}`;
  if (p.claimScores?.length) {
    return { claims: p.claimScores.map((score, i) => ({ label: name(i), score, band: bandOf(score) })), approximate: false };
  }
  const scores = [
    ...Array(p.bands.strong).fill(85),
    ...Array(p.bands.partial).fill(62),
    ...Array(p.bands.weak).fill(35),
  ];
  return { claims: scores.map((score, i) => ({ label: name(i), score, band: bandOf(score) })), approximate: true };
}
