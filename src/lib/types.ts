export type Difficulty = "standard" | "hard" | "expert";

export type ProbeType =
  | "explain_back"
  | "counterfactual"
  | "weakest_link"
  | "planted_error"
  | "prediction"
  | "confidence";

export type UnderstandingBand = "Weak" | "Partial" | "Strong";
export type IntegrityStatus = "Clear" | "Review" | "Concerns";

export interface Claim {
  id: string;
  text: string;
  section: string;
  sourceSpan: string;
  stakes: "high" | "medium" | "low";
}

export interface Probe {
  id: string;
  claimId: string;
  type: ProbeType;
  question: string;
  /** Altered text shown for planted-error probes */
  plantedContent?: string;
  expectedFocus: string;
}

export interface InterviewPlan {
  seed: string;
  difficulty: Difficulty;
  probes: Probe[];
  plantedErrorClaimId?: string;
}

export interface TurnRecord {
  id: string;
  probeId: string;
  question: string;
  answer: string;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  followUpIndex: number;
}

export interface DimensionScores {
  accuracy: number;
  reasoning: number;
  transfer: number;
  errorDetection: number;
  ownership: number;
}

export interface ClaimGrade {
  claimId: string;
  section: string;
  scores: DimensionScores;
  band: UnderstandingBand;
  evidence: string;
  reason: string;
}

export interface ModelGrade {
  modelId: string;
  provider: string;
  claimGrades: ClaimGrade[];
  overallScore: number;
}

export interface IntegritySignals {
  status: IntegrityStatus;
  observations: string[];
  avgLatencyMs: number;
  latencyVariance: number;
  pasteEvents: number;
  focusBlurEvents: number;
}

export interface ReceiptPayload {
  id: string;
  version: "defend-it-receipt-v1";
  createdAt: string;
  difficulty: Difficulty;
  score: number;
  bandSummary: { section: string; band: UnderstandingBand }[];
  creatorName: string;
  creatorEmail: string;
  deliverable: {
    fileName: string;
    sha256: string;
    byteLength: number;
  };
  rubricVersion: string;
  modelVersions: string[];
  integrity: IntegritySignals;
  evidence: {
    question: string;
    excerpt: string;
    band: UnderstandingBand;
    reason: string;
  }[];
  requestId: string;
  sessionId: string;
  attempt: number;
  assuranceLevel: "L1";
}

export interface SignedReceipt {
  payload: ReceiptPayload;
  signature: string;
  publicKey: string;
  verifyUrl: string;
}
