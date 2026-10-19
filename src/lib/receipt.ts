import { signPayload, verifySignature } from "./crypto";
import { appUrl } from "./config";
import { aggregateScore, RUBRIC_VERSION } from "./grading";
import { newReceiptId } from "./ids";
import type {
  Difficulty,
  IntegritySignals,
  InterviewMode,
  ModelGrade,
  ReceiptOutcome,
  ReceiptPayload,
  SignedReceipt,
} from "./types";

export function outcomeFor(score: number): ReceiptOutcome {
  if (score >= 70) return "Defended";
  if (score >= 45) return "Partially defended";
  return "Not defended";
}

export function countBands(grades: ModelGrade[]): ReceiptPayload["bands"] {
  const primary = grades[0];
  const bands = { strong: 0, partial: 0, weak: 0 };
  for (const cg of primary?.claimGrades ?? []) {
    if (cg.band === "Strong") bands.strong++;
    else if (cg.band === "Weak") bands.weak++;
    else bands.partial++;
  }
  return bands;
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
}): SignedReceipt {
  const score = aggregateScore(opts.grades);
  const payload: ReceiptPayload = {
    id: newReceiptId(),
    version: "defend-it-receipt-v2",
    createdAt: new Date().toISOString(),
    difficulty: opts.difficulty,
    score,
    outcome: outcomeFor(score),
    bands: countBands(opts.grades),
    ...(opts.claimScores?.length ? { claimScores: opts.claimScores } : {}),
    ...(opts.interviewMode ? { interviewMode: opts.interviewMode } : {}),
    deliverable: { sha256: opts.sha256, byteLength: opts.byteLength },
    rubricVersion: RUBRIC_VERSION,
    modelVersions: opts.grades.map((g) => `${g.provider}:${g.modelId}`),
    integrity: { status: opts.integrity.status },
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
