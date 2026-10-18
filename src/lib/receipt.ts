import { signPayload, verifySignature } from "./crypto";
import { RUBRIC_VERSION } from "./grading";
import type {
  Claim,
  Difficulty,
  IntegritySignals,
  ModelGrade,
  ReceiptPayload,
  SignedReceipt,
  TurnRecord,
  UnderstandingBand,
} from "./types";
import { aggregateScore, bandSummary } from "./grading";
import { newId } from "./ids";

export function buildSignedReceipt(opts: {
  requestId: string;
  sessionId: string;
  difficulty: Difficulty;
  creatorName: string;
  creatorEmail: string;
  fileName: string;
  sha256: string;
  byteLength: number;
  claims: Claim[];
  grades: ModelGrade[];
  turns: TurnRecord[];
  integrity: IntegritySignals;
  attempt?: number;
}): SignedReceipt {
  const score = aggregateScore(opts.grades);
  const bands = bandSummary(opts.grades, opts.claims);
  const primary = opts.grades[0];

  const evidence = opts.turns.map((t) => {
    const cg = primary?.claimGrades.find((g) =>
      opts.claims.some((c) => c.id === g.claimId),
    );
    const matched = matchGradeForTurn(primary, t, opts.claims);
    return {
      band: (matched?.band || cg?.band || "Partial") as UnderstandingBand,
    };
  });

  const payload: ReceiptPayload = {
    id: newId("rcpt"),
    version: "defend-it-receipt-v2",
    createdAt: new Date().toISOString(),
    difficulty: opts.difficulty,
    score,
    bandSummary: bands,
    creatorName: opts.creatorName,
    // creatorEmail stays on the session row and is not signed into the public receipt.
    deliverable: {
      fileName: opts.fileName,
      sha256: opts.sha256,
      byteLength: opts.byteLength,
    },
    rubricVersion: RUBRIC_VERSION,
    modelVersions: opts.grades.map((g) => `${g.provider}:${g.modelId}`),
    integrity: opts.integrity,
    evidence,
    requestId: opts.requestId,
    sessionId: opts.sessionId,
    attempt: opts.attempt ?? 1,
    assuranceLevel: "L1",
  };

  const { signature, publicKey } = signPayload(payload);
  const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  return {
    payload,
    signature,
    publicKey,
    verifyUrl: `${base}/verify/${payload.id}`,
  };
}

function matchGradeForTurn(
  grade: ModelGrade | undefined,
  turn: TurnRecord,
  claims: Claim[],
) {
  if (!grade) return undefined;
  // Best-effort: match by order index if claim linkage missing
  const idx = Number(turn.probeId?.slice(-1)) || 0;
  return grade.claimGrades[idx] || grade.claimGrades[0];
}

export function verifyReceipt(receipt: SignedReceipt): boolean {
  return verifySignature(
    receipt.payload,
    receipt.signature,
    receipt.publicKey,
  );
}
