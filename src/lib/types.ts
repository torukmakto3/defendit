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

export type ClaimKind = "claim" | "assumption" | "number";

/** 1 = straightforward, 2 = standard, 3 = the harder what-if / prediction items. */
export type QuestionDifficulty = 1 | 2 | 3;

export interface Claim {
  id: string;
  text: string;
  section: string;
  sourceSpan: string;
  stakes: "high" | "medium" | "low";
  /** What kind of load-bearing point this is. Inferred when the model omits it. */
  kind?: ClaimKind;
  /** Figures quoted from the document (the claim map's numbers). */
  figures?: string[];
}

export interface Probe {
  id: string;
  claimId: string;
  type: ProbeType;
  question: string;
  /** Item difficulty from the fixed blueprint. Older plans may omit it. */
  difficulty?: QuestionDifficulty;
  /** Set when this probe was added because graders disagreed on another probe. */
  followUpOf?: string;
  /**
   * Verbatim span from the claim map this question tests. Stored on the probe
   * so the creator's receipt can show it. It is not part of the public receipt.
   */
  sourceSpan?: string;
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
  /** Set when the grader returned a per-question id. */
  probeId?: string;
}

export interface ModelGrade {
  modelId: string;
  provider: string;
  claimGrades: ClaimGrade[];
  overallScore: number;
  /** Temperature sent with this grader's call. */
  temperature?: number;
  /** Seed sent with this grader's call. */
  seed?: number;
  /** True when the cap replaced the requested council model with the cheap model. */
  budgetFallback?: true;
}

export interface IntegritySignals {
  status: IntegrityStatus;
  observations: string[];
  avgLatencyMs: number;
  latencyVariance: number;
  pasteEvents: number;
  focusBlurEvents: number;
}

export type InterviewMode = "voice" | "text" | "text-accommodation";

export type ReceiptOutcome = "Defended" | "Partially defended" | "Not defended";

/** One grader's call settings, as signed on the receipt. */
export interface ReceiptGrader {
  /** `provider:modelId`, matching an entry in `modelVersions`. */
  model: string;
  temperature: number;
  seed: number;
  /**
   * Set when this grader is the cheap model used because the defense was over
   * its cap. Absent on a normal council grade and on receipts minted before
   * the mark existed.
   */
  budgetFallback?: true;
}

/**
 * v2 receipt: only what a receiver needs to trust the file they hold.
 * No file name, email, transcript excerpts, section names or internal ids:
 * the receipt is public to anyone with its link and must not leak the
 * deliverable or the creator's contact details.
 */
export interface ReceiptPayload {
  id: string;
  version: "defend-it-receipt-v2";
  createdAt: string;
  difficulty: Difficulty;
  score: number;
  outcome: ReceiptOutcome;
  /** How many probed claims landed in each band. */
  bands: { strong: number; partial: number; weak: number };
  /**
   * Score 0-100 for each probed claim, in interview order. Anonymous on
   * purpose: numbers only, no claim text (the receipt is public).
   */
  claimScores?: number[];
  /** How the defense was taken: live voice, typed, or typed as an accessibility accommodation. */
  interviewMode?: InterviewMode;
  deliverable: {
    sha256: string;
    byteLength: number;
  };
  rubricVersion: string;
  modelVersions: string[];
  /**
   * Model, temperature, and seed for each grader, covered by the signature.
   * `model` is `provider:modelId`, the same string as `modelVersions`.
   * Receipts minted before this field omit it and still verify.
   */
  graders?: ReceiptGrader[];
  integrity: { status: IntegrityStatus };
  /**
   * Present only when the creator chose to show their name. The name is
   * self-reported; only the account's email was verified at sign-in.
   */
  creator?: { displayName: string; nameSelfReported: true };
  attempt: number;
  assuranceLevel: "L1";
  /**
   * Present only on a no-login sample defense. Covered by the signature.
   * `credential` is false: the receipt shows what a defense looks like and
   * does not attest to the visitor.
   */
  demo?: {
    sample: true;
    credential: false;
    /** Bundled sample title. Not document text and not a visitor's file name. */
    file: string;
    /** ISO time after which the receipt is no longer served. */
    expiresAt: string;
  };
}

export interface SignedReceipt {
  payload: ReceiptPayload;
  signature: string;
  publicKey: string;
  verifyUrl: string;
}
