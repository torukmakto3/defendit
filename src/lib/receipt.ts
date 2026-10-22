import { signPayload, verifySignature } from "./crypto";
import { appUrl } from "./config";
import { aggregateScore, RUBRIC_VERSION, scoreDefense } from "./grading";
import { newReceiptId } from "./ids";
import type {
  Difficulty,
  IntegritySignals,
  InterviewMode,
  InterviewPlan,
  ModelGrade,
  ReceiptGrader,
  ReceiptOutcome,
  ReceiptPayload,
  SignedReceipt,
} from "./types";

export function outcomeFor(score: number): ReceiptOutcome {
  if (score >= 70) return "Defended";
  if (score >= 45) return "Partially defended";
  return "Not defended";
}

export function countBands(grades: ModelGrade[], plan?: InterviewPlan): ReceiptPayload["bands"] {
  if (plan && grades.some((g) => g.claimGrades.length > 0)) return scoreDefense(grades, plan).bands;
  const primary = grades[0];
  const bands = { strong: 0, partial: 0, weak: 0 };
  for (const cg of primary?.claimGrades ?? []) {
    if (cg.band === "Strong") bands.strong++;
    else if (cg.band === "Weak") bands.weak++;
    else bands.partial++;
  }
  return bands;
}

/**
 * Per-grader settings for the signature. Omitted when any grade lacks a
 * temperature or seed, so a receipt built from older grade rows keeps the
 * model-only shape.
 */
function gradersForReceipt(grades: ModelGrade[]): ReceiptGrader[] | undefined {
  if (grades.length === 0) return undefined;
  const graders: ReceiptGrader[] = [];
  for (const grade of grades) {
    if (typeof grade.temperature !== "number" || !Number.isFinite(grade.temperature)) return undefined;
    if (typeof grade.seed !== "number" || !Number.isInteger(grade.seed)) return undefined;
    graders.push({
      model: `${grade.provider}:${grade.modelId}`,
      temperature: grade.temperature,
      seed: grade.seed,
      ...(grade.budgetFallback ? { budgetFallback: true as const } : {}),
    });
  }
  return graders;
}

export function buildSignedReceipt(opts: {
  difficulty: Difficulty;
  sha256: string;
  byteLength: number;
  grades: ModelGrade[];
  integrity: IntegritySignals;
  displayName?: string | null;
  claimScores?: number[];
  interviewMode?: InterviewMode;
  attempt?: number;
  plan?: InterviewPlan;
}): SignedReceipt {
  const score = aggregateScore(opts.grades, opts.plan);
  const graders = gradersForReceipt(opts.grades);
  const payload: ReceiptPayload = {
    id: newReceiptId(),
    version: "defend-it-receipt-v2",
    createdAt: new Date().toISOString(),
    difficulty: opts.difficulty,
    score,
    outcome: outcomeFor(score),
    bands: countBands(opts.grades, opts.plan),
    ...(opts.claimScores?.length ? { claimScores: opts.claimScores } : {}),
    ...(opts.interviewMode ? { interviewMode: opts.interviewMode } : {}),
    deliverable: { sha256: opts.sha256, byteLength: opts.byteLength },
    rubricVersion: RUBRIC_VERSION,
    modelVersions: opts.grades.map((g) => `${g.provider}:${g.modelId}`),
    ...(graders ? { graders } : {}),
    integrity: {
      status: opts.integrity.status,
      ...(opts.integrity.pasteEvents > 0 ? { pasteEvents: opts.integrity.pasteEvents } : {}),
      ...(opts.integrity.focusBlurEvents > 0 ? { focusBlurEvents: opts.integrity.focusBlurEvents } : {}),
    },
    attempt: opts.attempt ?? 1,
    assuranceLevel: "L1",
  };
  if (opts.displayName) {
    payload.creator = { displayName: opts.displayName, nameSelfReported: true };
  }

  const { signature, publicKey } = signPayload(payload);
  return {
    payload,
    signature,
    publicKey,
    verifyUrl: appUrl(`/verify/${payload.id}`),
  };
}

export function verifyReceipt(receipt: SignedReceipt): boolean {
  return verifySignature(receipt.payload, receipt.signature, receipt.publicKey);
}
