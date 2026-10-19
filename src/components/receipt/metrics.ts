import type { ReceiptPayload } from "@/lib/types";

export type Band = "strong" | "partial" | "weak";
export interface ClaimResult {
  label: string;
  score: number;
  band: Band;
}

/** Bands use the rubric's thresholds: strong 75+, partial 50+, weak below. */
export function bandOf(score: number): Band {
  return score >= 75 ? "strong" : score >= 50 ? "partial" : "weak";
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
