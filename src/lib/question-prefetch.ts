import { sha256Hex } from "./crypto";
import { getDb } from "./db";
import { newId } from "./ids";
import { buildInterviewPlan } from "./probes";
import { phraseQuestions } from "./questions";
import { recordStageTiming } from "./timings";
import type { Claim, Difficulty, InterviewPlan } from "./types";
import { decryptJson, encryptJson } from "./vault";

/**
 * The first interview question, phrased while the upload is saved.
 * The rest of the questions are phrased when the defense starts, after this
 * one has already been shown.
 */
export interface QuestionPrefetch {
  seed: string;
  difficulty: Difficulty;
  fingerprint: string;
  plan: InterviewPlan;
  /** True when every probe was already phrased (a one-question plan). */
  restPhrased: boolean;
  firstQuestionMs: number;
}

const prefetchCtx = (requestId: string) => `defense_requests.question_prefetch:${requestId}`;

export function questionPrefetchFingerprint(
  claims: Claim[],
  pinnedClaimIds?: string[],
  shape?: "demo",
): string {
  const pins = [...(pinnedClaimIds ?? [])].map((id) => id.trim()).filter(Boolean).sort();
  const body: { pins: string[]; claims: [string, string][]; shape?: "demo" } = {
    pins,
    claims: claims.map((claim) => [claim.id, claim.text]),
  };
  if (shape === "demo") body.shape = "demo";
  return sha256Hex(JSON.stringify(body));
}

/** Phrase probe 0 only. The plan's later questions stay on their templates. */
export async function precomputeFirstQuestion(opts: {
  claims: Claim[];
  difficulty: Difficulty;
  pinnedClaimIds?: string[];
  shape?: "demo";
}): Promise<QuestionPrefetch> {
  const seed = newId("seed");
  const drafted = buildInterviewPlan({
    claims: opts.claims,
    difficulty: opts.difficulty,
    seed,
    pinnedClaimIds: opts.pinnedClaimIds,
    shape: opts.shape,
  });
  const started = Date.now();
  const plan = await phraseQuestions(drafted, opts.claims, { indexes: [0] });
  return {
    seed,
    difficulty: opts.difficulty,
    fingerprint: questionPrefetchFingerprint(opts.claims, opts.pinnedClaimIds, opts.shape),
    plan,
    restPhrased: plan.probes.length <= 1,
    firstQuestionMs: Math.max(0, Date.now() - started),
  };
}

export async function saveQuestionPrefetch(requestId: string, prefetch: QuestionPrefetch): Promise<void> {
  const db = await getDb();
  await db.run(`UPDATE defense_requests SET question_prefetch_enc = ? WHERE id = ?`, [
    encryptJson(prefetch, prefetchCtx(requestId)),
    requestId,
  ]);
}

export async function loadQuestionPrefetch(
  requestId: string,
  claims: Claim[],
  difficulty: Difficulty,
  pinnedClaimIds?: string[],
  shape?: "demo",
): Promise<QuestionPrefetch | null> {
  const db = await getDb();
  const row = await db.get<{ question_prefetch_enc: string | null }>(
    `SELECT question_prefetch_enc FROM defense_requests WHERE id = ?`,
    [requestId],
  );
  if (!row?.question_prefetch_enc) return null;
  const stored = decryptJson<QuestionPrefetch>(row.question_prefetch_enc, prefetchCtx(requestId));
  if (!stored?.plan?.probes?.length || !stored.seed) return null;
  if (stored.difficulty !== difficulty) return null;
  if (stored.fingerprint !== questionPrefetchFingerprint(claims, pinnedClaimIds, shape)) return null;
  return stored;
}

/**
 * Record upload/parse, then keep the first question that was phrased in
 * parallel with the deliverable insert. A failed phrase leaves the upload intact.
 */
export async function rememberFirstQuestion(opts: {
  requestId: string;
  prefetch: Promise<QuestionPrefetch>;
  parseMs: number;
}): Promise<void> {
  await recordStageTiming({
    requestId: opts.requestId,
    stage: "upload_parse",
    durationMs: opts.parseMs,
  });
  try {
    const prefetch = await opts.prefetch;
    await saveQuestionPrefetch(opts.requestId, prefetch);
    await recordStageTiming({
      requestId: opts.requestId,
      stage: "first_question",
      durationMs: prefetch.firstQuestionMs,
    });
  } catch (e) {
    console.warn("[questions] first question was not precomputed:", e instanceof Error ? e.message : e);
  }
}
