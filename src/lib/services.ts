import type { User } from "./auth";
import { extractClaims } from "./claims";
import {
  assertLearnSlotAvailable,
  finishDefenseCredit,
  refundStaleDefenseHolds,
  reserveChallengeDefenseBudget,
} from "./credits";
import { getPublicKeyHex, sha256Hex } from "./crypto";
import { dashboardWorkspaceHref } from "./dashboard-links";
import { getDb, type Db } from "./db";
import { aggregateScore, claimScores, gradeSession, scoreDefense, shouldFlagForHuman } from "./grading";
import { readGradingProgress, type GradingProgress } from "./grading-progress";
import { HttpError } from "./http";
import { newId, newToken } from "./ids";
import { computeIntegrity } from "./integrity";
import { nextLearnTurn, type GapItem } from "./learn";
import {
  budgetUsdForTier,
  budgetUsdForUser,
  costReportLimit,
  getCostTier,
  parseCostTier,
  secondRoundFits,
  summarizeCosts,
  voiceCostUsd,
  type CostTier,
} from "./cost";
import {
  defenseCapState,
  describeGradingCouncil,
  flushLlmScope,
  getGradingCouncil,
  llmModeLabel,
  markDefenseCapped,
  refreshRequestUsage,
  scopeWasCapped,
  withLlmScope,
} from "./llm";
import { extractText, guessMimeType } from "./parse";
import { buildInterviewPlan, buildLearnPlan, makeFollowUpProbe } from "./probes";
import { loadQuestionPrefetch, precomputeFirstQuestion, rememberFirstQuestion } from "./question-prefetch";
import { phraseQuestions } from "./questions";
import { listStageTimings, recordStageTiming } from "./timings";
import { buildSignedReceipt } from "./receipt";
import type {
  Claim,
  Difficulty,
  InterviewPlan,
  ModelGrade,
  SignedReceipt,
  TurnRecord,
} from "./types";
import {
  assertChallengeAllowsWork,
  challengeCompletionHint,
  expireDueChallenges,
  noteChallengeDefended,
  noteChallengeSession,
  noteChallengeUpload,
} from "./challenges";
import { decryptField, decryptJson, encryptField, encryptJson } from "./vault";

/**
 * Data lifecycle ("process and purge"):
 * - Raw upload bytes are parsed in memory and never stored; only the SHA-256 is kept.
 * - Extracted document text is encrypted and deleted when the defense completes,
 *   or after DOCUMENT_TTL_HOURS for Learn-only use. A flashcard deck is cached
 *   first, encrypted, and kept for the deliverable's retention window so Learn
 *   can continue. The raw text is not kept longer than that.
 * - Claims, transcripts, grades and the file name are encrypted and deleted
 *   after RETENTION_DAYS. Receipts (hash + score, no content) are kept.
 */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 4 * 1024 * 1024);
const MAX_TEXT_CHARS = 400_000;

function hoursFromNow(h: number) {
  return new Date(Date.now() + h * 3600_000).toISOString();
}
const documentTtlHours = () => Number(process.env.DOCUMENT_TTL_HOURS || "72");
const retentionDays = () => Number(process.env.RETENTION_DAYS || "30");

const ctx = {
  fileName: (id: string) => `deliverables.file_name:${id}`,
  text: (id: string) => `deliverables.text:${id}`,
  claims: (id: string) => `deliverables.claims:${id}`,
  plan: (id: string) => `sessions.plan:${id}`,
  transcript: (id: string) => `sessions.transcript:${id}`,
  gapMap: (id: string) => `sessions.gap_map:${id}`,
  scores: (id: string) => `grades.scores:${id}`,
};

const isPast = (iso: string | null | undefined) => !!iso && iso < new Date().toISOString();

/**
 * Expiry is enforced on every read, not only by the purge job: if the cron
 * is misconfigured or late, expired content still behaves as deleted.
 */
function liveText(d: DeliverableRow): string | null {
  if (!d.text_enc || isPast(d.text_purge_after) || isPast(d.purge_after)) return null;
  return decryptField(d.text_enc, ctx.text(d.id));
}

function liveClaims(d: DeliverableRow): Claim[] | null {
  if (d.purged_at || isPast(d.purge_after)) return null;
  return decryptJson<Claim[]>(d.claims_enc, ctx.claims(d.id));
}

function liveFileName(d: DeliverableRow): string | null {
  if (d.purged_at || isPast(d.purge_after)) return null;
  return decryptField(d.file_name_enc, ctx.fileName(d.id));
}

/** Stored title for creator-initiated defenses: never the file name, which can be sensitive. */
const PRIVATE_TITLE = "Private deliverable";

let lastOpportunisticPurge = 0;
/** Backstop for the daily cron: at most hourly per instance, never fails the caller. */
function maybePurge() {
  const now = Date.now();
  if (now - lastOpportunisticPurge < 3600_000) return;
  lastOpportunisticPurge = now;
  purgeExpired().catch((e) => console.error("[purge] opportunistic purge failed", e instanceof Error ? e.message : e));
}

interface RequestRow {
  id: string;
  token: string;
  owner_user_id: string;
  creator_user_id: string | null;
  kind: "creator" | "receiver";
  difficulty: Difficulty;
  title: string;
  notes: string | null;
  pinned_claims: string | null;
  status: string;
  created_at: string;
}

interface DeliverableRow {
  id: string;
  request_id: string;
  owner_user_id: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
  claim_count: number;
  file_name_enc: string | null;
  text_enc: string | null;
  claims_enc: string | null;
  text_purge_after: string | null;
  purge_after: string;
  purged_at: string | null;
  created_at: string;
}

interface SessionRow {
  id: string;
  request_id: string;
  deliverable_id: string;
  user_id: string;
  mode: "learn" | "defend";
  seed: string;
  plan_enc: string | null;
  transcript_enc: string | null;
  gap_map_enc: string | null;
  integrity_json: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  purge_after: string;
  channel: Channel;
  grading_claimed_at?: string | null;
  grading_progress?: string | null;
}

/** A grading claim older than the complete route's 120s limit is abandoned. */
export const GRADING_CLAIM_TTL_MS = 120_000;

/** How a Defend session takes answers. Hard and Expert require voice unless an accommodation is requested. */
export type Channel = "text" | "voice" | "text_accommodation";

export function channelFor(difficulty: Difficulty, opts: { voice?: boolean; accommodation?: boolean }): Channel {
  if (difficulty === "standard") return opts.voice ? "voice" : "text";
  return opts.accommodation ? "text_accommodation" : "voice";
}

interface NewRequest {
  owner: User;
  kind: "creator" | "receiver";
  difficulty: Difficulty;
  title: string;
  notes?: string;
  pinnedClaims?: string;
}

async function insertRequest(db: Db, input: NewRequest) {
  const requestId = newId("req");
  const token = newToken();
  await db.run(
    `INSERT INTO defense_requests
      (id, token, owner_user_id, creator_user_id, kind, difficulty, title, notes, pinned_claims, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      requestId,
      token,
      input.owner.id,
      input.kind === "creator" ? input.owner.id : null,
      input.kind,
      input.difficulty,
      input.title.slice(0, 200),
      input.notes?.slice(0, 2000) || null,
      input.pinnedClaims?.slice(0, 500) || null,
      new Date().toISOString(),
    ],
  );
  return { requestId, token };
}

export async function createDefenseRequest(input: NewRequest) {
  return insertRequest(await getDb(), input);
}

interface PreparedUpload {
  fileName: string;
  mime: string;
  sha256: string;
  byteLength: number;
  text: string;
  claims: Claim[];
  parseMs: number;
}

/** Parse and extract claims before anything is written, so failures leave no rows behind. */
async function prepareUpload(fileName: string, buffer: Buffer, mimeType?: string): Promise<PreparedUpload> {
  const started = Date.now();
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `File is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }
  const mime = mimeType || guessMimeType(fileName);
  let text: string;
  try {
    text = (await extractText(buffer, mime, fileName)).slice(0, MAX_TEXT_CHARS);
  } catch {
    throw new HttpError(400, "Could not read that file. Try PDF, DOCX, XLSX, CSV, TXT or MD.");
  }
  if (!text || text.length < 20) {
    throw new HttpError(400, "Could not extract enough text from the upload.");
  }
  const claims = await extractClaims(text);
  return {
    fileName,
    mime,
    sha256: sha256Hex(buffer),
    byteLength: buffer.length,
    text,
    claims,
    parseMs: Date.now() - started,
  };
}

async function insertDeliverable(db: Db, requestId: string, user: User, u: PreparedUpload) {
  const deliverableId = newId("del");
  await db.run(
    `INSERT INTO deliverables
      (id, request_id, owner_user_id, mime_type, byte_length, sha256, claim_count,
       file_name_enc, text_enc, claims_enc, text_purge_after, purge_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deliverableId,
      requestId,
      user.id,
      u.mime,
      u.byteLength,
      u.sha256,
      u.claims.length,
      encryptField(u.fileName.slice(0, 255), ctx.fileName(deliverableId)),
      encryptField(u.text, ctx.text(deliverableId)),
      encryptJson(u.claims, ctx.claims(deliverableId)),
      hoursFromNow(documentTtlHours()),
      hoursFromNow(retentionDays() * 24),
      new Date().toISOString(),
    ],
  );
  return deliverableId;
}

/** Creator-driven entry: drop a file, we mint a self-request, then Learn / Defend. */
export async function creatorIngest(opts: {
  user: User;
  fileName: string;
  buffer: Buffer;
  difficulty?: Difficulty;
  mimeType?: string;
}) {
  maybePurge();
  // Claim extraction runs before the request row exists. Hold those calls,
  // then attach them once the id is known. The slot claim shares that insert.
  return withLlmScope({ user: opts.user }, async () => {
    const upload = await prepareUpload(opts.fileName, opts.buffer, opts.mimeType);
    const difficulty = opts.difficulty || "hard";
    // Phrase the first question while the deliverable row is written.
    const prefetchPromise = precomputeFirstQuestion({ claims: upload.claims, difficulty });
    const db = await getDb();
    const result = await db.transaction(async (tx) => {
      await assertLearnSlotAvailable(opts.user.id, tx);
      const created = await insertRequest(tx, {
        owner: opts.user,
        kind: "creator",
        difficulty,
        title: PRIVATE_TITLE,
      });
      const deliverableId = await insertDeliverable(tx, created.requestId, opts.user, upload);
      await tx.run(`UPDATE defense_requests SET status = 'uploaded' WHERE id = ?`, [created.requestId]);
      return { ...created, deliverableId };
    });
    await rememberFirstQuestion({
      requestId: result.requestId,
      prefetch: prefetchPromise,
      parseMs: upload.parseMs,
    });
    await flushLlmScope({ requestId: result.requestId });
    return {
      ...result,
      sha256: upload.sha256,
      claimCount: upload.claims.length,
      textLength: upload.text.length,
      title: displayTitle(opts.fileName),
    };
  });
}

function displayTitle(fileName: string | null): string {
  return fileName?.replace(/\.[^.]+$/, "").slice(0, 120) || PRIVATE_TITLE;
}

export async function getRequestByToken(token: string) {
  const db = await getDb();
  return db.get<RequestRow>(`SELECT * FROM defense_requests WHERE token = ?`, [token]);
}

async function requireRequest(token: string): Promise<RequestRow> {
  const request = await getRequestByToken(token);
  if (!request) throw new HttpError(404, "Defense link not found");
  return request;
}

/** Only the creator may upload, learn or defend; the receiver may watch status. */
function assertCreator(request: RequestRow, user: User) {
  if (request.creator_user_id && request.creator_user_id !== user.id) {
    throw new HttpError(403, "This defense belongs to another account");
  }
  if (!request.creator_user_id && request.kind === "creator") {
    throw new HttpError(403, "This defense belongs to another account");
  }
}

/** What the workspace page may show to the signed-in user. */
export async function getRequestView(token: string, user: User | null) {
  const request = await requireRequest(token);
  const isCreator = !!user && request.creator_user_id === user.id;
  const isOwner = !!user && request.owner_user_id === user.id;
  const canClaim =
    !!user &&
    !request.creator_user_id &&
    request.kind === "receiver" &&
    request.owner_user_id !== user.id;
  const view = {
    title: request.title,
    // Creator-initiated titles are filled in from the encrypted file name below.
    difficulty: request.difficulty,
    status: request.status,
    kind: request.kind,
    notes: request.notes,
    isCreator,
    isOwner,
    canClaim,
    deliverable: null as null | {
      fileName: string | null;
      sha256: string;
      byteLength: number;
      claimCount: number;
      documentAvailable: boolean;
      studyDeck: boolean;
      purged: boolean;
    },
  };
  if (isCreator || isOwner) {
    const d = await getLatestDeliverable(request.id);
    if (d) {
      const fileName = liveFileName(d);
      const purged = !!d.purged_at || isPast(d.purge_after);
      let studyDeck = false;
      if (isCreator && user) {
        const db = await getDb();
        const deck = await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM flashcards WHERE deliverable_id = ? AND user_id = ? AND purge_after >= ?`,
          [d.id, user.id, new Date().toISOString()],
        );
        studyDeck = Number(deck?.n) > 0;
      }
      view.deliverable = {
        fileName,
        sha256: d.sha256,
        byteLength: d.byte_length,
        claimCount: d.claim_count,
        documentAvailable: !purged && !!d.text_enc && !isPast(d.text_purge_after),
        studyDeck,
        purged,
      };
      if (request.kind === "creator") view.title = displayTitle(fileName);
    }
  }
  return view;
}

export async function ingestDeliverable(opts: {
  token: string;
  user: User;
  fileName: string;
  buffer: Buffer;
  mimeType?: string;
}) {
  maybePurge();
  const request = await requireRequest(opts.token);
  const claiming = request.kind === "receiver" && !request.creator_user_id;
  if (claiming) {
    if (request.owner_user_id === opts.user.id) {
      throw new HttpError(403, "Send this link to the person who should defend the deliverable.");
    }
  } else {
    assertCreator(request, opts.user);
  }
  if (request.status === "defended") {
    throw new HttpError(409, "This deliverable has already been defended.");
  }
  await assertChallengeAllowsWork(request.id);

  const { upload, deliverableId } = await withLlmScope({ requestId: request.id, user: opts.user }, async () => {
    const upload = await prepareUpload(opts.fileName, opts.buffer, opts.mimeType);
    const pinnedClaimIds = request.pinned_claims
      ? request.pinned_claims.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const prefetchPromise = precomputeFirstQuestion({
      claims: upload.claims,
      difficulty: request.difficulty,
      pinnedClaimIds,
    });
    const db = await getDb();
    const deliverableId = await db.transaction(async (tx) => {
    if (claiming) {
      await assertLearnSlotAvailable(opts.user.id, tx);
      const claimed = await tx.run(
        `UPDATE defense_requests SET creator_user_id = ? WHERE id = ? AND creator_user_id IS NULL`,
        [opts.user.id, request.id],
      );
      if (claimed.changes !== 1) throw new HttpError(403, "This defense belongs to another account");
    }
    // Never move a defended request back: its receipt is bound to the earlier hash.
    const open = await tx.run(
      `UPDATE defense_requests SET status = 'uploaded' WHERE id = ? AND status <> 'defended'`,
      [request.id],
    );
    if (open.changes !== 1) throw new HttpError(409, "This deliverable has already been defended.");
    return insertDeliverable(tx, request.id, opts.user, upload);
    });
    await rememberFirstQuestion({
      requestId: request.id,
      prefetch: prefetchPromise,
      parseMs: upload.parseMs,
    });
    return { upload, deliverableId };
  });
  await noteChallengeUpload(request.id, deliverableId);

  return {
    deliverableId,
    sha256: upload.sha256,
    claimCount: upload.claims.length,
    textLength: upload.text.length,
  };
}

async function getLatestDeliverable(requestId: string) {
  const db = await getDb();
  return db.get<DeliverableRow>(
    `SELECT * FROM deliverables WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`,
    [requestId],
  );
}

export interface FirstQuestionInfo {
  sessionId: string;
  requestId: string;
  channel: Channel;
  total: number;
  question: string;
  probe: ReturnType<typeof publicProbes>[number];
}

export async function startSession(opts: {
  token: string;
  user: User;
  mode: "learn" | "defend";
  voice?: boolean;
  accommodation?: boolean;
  /**
   * Called once the first question is stored, before the remaining questions
   * are phrased. The interview can show that question while the rest are written.
   */
  onFirstQuestion?: (info: FirstQuestionInfo) => void | Promise<void>;
}) {
  maybePurge();
  const request = await requireRequest(opts.token);
  assertCreator(request, opts.user);
  const deliverable = await getLatestDeliverable(request.id);
  if (!deliverable) throw new HttpError(400, "Upload a deliverable first");
  const claims = liveClaims(deliverable);
  if (!claims) throw new HttpError(410, "This upload has been purged. Upload the file again.");
  if (opts.mode === "learn" && !liveText(deliverable)) {
    throw new HttpError(410, "The document text has been purged. Upload the file again to keep learning.");
  }
  if (opts.mode === "defend" && request.status === "defended") {
    throw new HttpError(409, "This deliverable has already been defended.");
  }
  if (opts.mode === "defend") {
    await assertChallengeAllowsWork(request.id);
    // Beta challenge defenses skip the defender's credit in the route and
    // reserve the shared euro budget here instead.
    await reserveChallengeDefenseBudget(request.id, opts.user.id);
  }

  const sessionId = newId("ses");
  const channel: Channel = opts.mode === "defend" ? channelFor(request.difficulty, opts) : "text";
  const pinned = request.pinned_claims
    ? request.pinned_claims.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  let seed: string;
  let plan: InterviewPlan;
  let phraseRest = false;
  let cappedDuringPhrase = false;

  if (opts.mode === "learn") {
    seed = newId("seed");
    plan = buildLearnPlan(claims, seed);
  } else {
    const prefetched = await loadQuestionPrefetch(request.id, claims, request.difficulty, pinned);
    if (prefetched) {
      seed = prefetched.seed;
      plan = prefetched.plan;
      phraseRest = !prefetched.restPhrased;
    } else {
      seed = newId("seed");
      plan = buildInterviewPlan({
        claims,
        difficulty: request.difficulty,
        seed,
        pinnedClaimIds: pinned,
      });
      const started = Date.now();
      let phrasingCapped = false;
      plan = await withLlmScope({ sessionId, requestId: request.id, user: opts.user }, async () => {
        const phrased = await phraseQuestions(plan, claims, { indexes: [0] });
        phrasingCapped = scopeWasCapped();
        return phrased;
      });
      await recordStageTiming({
        requestId: request.id,
        sessionId,
        stage: "first_question",
        durationMs: Date.now() - started,
      });
      phraseRest = plan.probes.length > 1;
      cappedDuringPhrase = phrasingCapped;
    }
  }

  const db = await getDb();
  await insertSessionRow(db, {
    sessionId,
    requestId: request.id,
    deliverableId: deliverable.id,
    userId: opts.user.id,
    mode: opts.mode,
    seed,
    plan,
    channel,
    user: opts.user,
    budgetCapped: cappedDuringPhrase,
  });

  // The row exists, so the client can render question 1 while the rest are phrased.
  const firstProbe = publicProbes(plan)[0];
  const shown =
    opts.mode === "defend" && opts.onFirstQuestion && firstProbe
      ? Promise.resolve(
          opts.onFirstQuestion({
            sessionId,
            requestId: request.id,
            channel,
            total: plan.probes.length,
            question: firstProbe.question,
            probe: firstProbe,
          }),
        )
      : null;

  if (phraseRest) {
    const rest = plan.probes.map((_, index) => index).filter((index) => index !== 0);
    plan = await withLlmScope({ sessionId, requestId: request.id, user: opts.user }, () =>
      phraseQuestions(plan, claims, { indexes: rest }),
    );
    await db.run(`UPDATE sessions SET plan_enc = ? WHERE id = ?`, [
      encryptJson(plan, ctx.plan(sessionId)),
      sessionId,
    ]);
  }

  if (shown) await shown;
  await refreshRequestUsage(request.id);
  if (opts.mode === "defend") await noteChallengeSession(request.id, sessionId);
  return { sessionId, plan, channel };
}

async function insertSessionRow(
  db: Db,
  row: {
    sessionId: string;
    requestId: string;
    deliverableId: string;
    userId: string;
    mode: "learn" | "defend";
    seed: string;
    plan: InterviewPlan;
    channel: Channel;
    user: User;
    budgetCapped: boolean;
  },
) {
  const tier = getCostTier(row.user);
  await db.run(
    `INSERT INTO sessions
      (id, request_id, deliverable_id, user_id, mode, seed, plan_enc, transcript_enc, gap_map_enc, status, started_at, purge_after, channel, cost_tier, budget_usd, budget_capped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
    [
      row.sessionId,
      row.requestId,
      row.deliverableId,
      row.userId,
      row.mode,
      row.seed,
      encryptJson(row.plan, ctx.plan(row.sessionId)),
      encryptJson([], ctx.transcript(row.sessionId)),
      encryptJson([], ctx.gapMap(row.sessionId)),
      new Date().toISOString(),
      hoursFromNow(retentionDays() * 24),
      row.channel,
      tier,
      budgetUsdForUser(row.user),
      row.budgetCapped ? 1 : 0,
    ],
  );
}

/** Strip what the creator must not see before answering (expected answers). */
export function publicProbes(plan: InterviewPlan) {
  return plan.probes.map((probe) => {
    const visible: Partial<typeof probe> = { ...probe };
    delete visible.expectedFocus;
    return visible as Omit<typeof probe, "expectedFocus">;
  });
}

async function requireOwnSession(sessionId: string, user: User, mode: "learn" | "defend") {
  const db = await getDb();
  const session = await db.get<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [sessionId]);
  if (!session || session.mode !== mode || session.user_id !== user.id) {
    throw new HttpError(404, `${mode === "learn" ? "Learn" : "Defend"} session not found`);
  }
  if (isPast(session.purge_after)) throw new HttpError(410, "This session has expired.");
  return session;
}

export async function learnCoachTurn(opts: { sessionId: string; user: User; answer?: string }) {
  const session = await requireOwnSession(opts.sessionId, opts.user, "learn");
  const db = await getDb();
  const deliverable = await db.get<DeliverableRow>(`SELECT * FROM deliverables WHERE id = ?`, [
    session.deliverable_id,
  ]);
  const text = deliverable ? liveText(deliverable) : null;
  const claims = deliverable ? liveClaims(deliverable) : null;
  if (!deliverable || !text || !claims) {
    throw new HttpError(410, "The document text has been purged. Upload the file again to keep learning.");
  }

  const history =
    decryptJson<{ role: "coach" | "creator"; content: string }[]>(
      session.transcript_enc,
      ctx.transcript(session.id),
    ) ?? [];
  const gaps = decryptJson<GapItem[]>(session.gap_map_enc, ctx.gapMap(session.id)) ?? [];

  if (opts.answer) history.push({ role: "creator", content: opts.answer.slice(0, 4000) });

  const result = await withLlmScope({ sessionId: session.id, requestId: session.request_id, user: opts.user }, () =>
    nextLearnTurn({
      documentExcerpt: text,
      claims,
      history,
      turnIndex: history.filter((h) => h.role === "creator").length + 1,
    }),
  );

  history.push({ role: "coach", content: result.coachMessage });
  if (result.gapHint) gaps.push(result.gapHint);

  await db.run(
    `UPDATE sessions SET transcript_enc = ?, gap_map_enc = ?, status = ? WHERE id = ?`,
    [
      encryptJson(history, ctx.transcript(session.id)),
      encryptJson(gaps, ctx.gapMap(session.id)),
      result.done ? "completed" : "in_progress",
      session.id,
    ],
  );
  return { ...result, gaps, history };
}

/**
 * Record one Defend answer as it is given. The server fixes the order (the
 * next unanswered probe in its own plan), the question text and the timing:
 * latency is measured from the previous answer (or the session start) to
 * this request, so a client can't swap in easier questions or fake pacing.
 */
export async function recordDefendAnswer(opts: {
  sessionId: string;
  user: User;
  probeId: string;
  answer: string;
}) {
  const session = await requireOwnSession(opts.sessionId, opts.user, "defend");
  if (session.channel === "voice") {
    const plan = decryptJson<InterviewPlan>(session.plan_enc, ctx.plan(session.id));
    const turns = decryptJson<TurnRecord[]>(session.transcript_enc, ctx.transcript(session.id)) ?? [];
    const next = plan?.probes[turns.length];
    const already = turns.some((t) => t.probeId === opts.probeId);
    // A disagreement follow-up is typed even when the rest of the defense was spoken.
    if (!next?.followUpOf && !already) {
      throw new HttpError(409, "This defense is taken by voice; answers are recorded from the call.");
    }
  }
  return storeAnswer(session, opts.probeId, opts.answer);
}

/**
 * A spoken answer reported by the interviewer agent (authenticated by the
 * agent API). The agent measured when the question finished and when the
 * creator started and stopped speaking; the server bounds-checks the times.
 */
export async function recordVoiceAnswer(opts: {
  sessionId: string;
  probeId: string;
  answer: string;
  questionEndedAt: string;
  answerStartedAt: string;
  answerEndedAt: string;
}) {
  const db = await getDb();
  const session = await db.get<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [opts.sessionId]);
  if (!session || session.mode !== "defend" || session.channel !== "voice") {
    throw new HttpError(404, "Voice session not found");
  }
  // Times must fall inside this session; order is not enforced because people
  // often start answering before the examiner's audio has fully finished.
  const lo = new Date(session.started_at).getTime() - 5_000;
  const hi = Date.now() + 5_000;
  const [qEnd, aStart, aEnd] = [opts.questionEndedAt, opts.answerStartedAt, opts.answerEndedAt].map((x) =>
    new Date(x).getTime(),
  );
  if ([qEnd, aStart, aEnd].some((x) => !Number.isFinite(x) || x < lo || x > hi)) {
    throw new HttpError(400, "Answer timing is out of range");
  }
  const t = [qEnd, Math.min(aStart, aEnd), aEnd];
  return storeAnswer(session, opts.probeId, opts.answer, {
    startedAt: new Date(Math.min(t[0], t[1])).toISOString(),
    endedAt: new Date(t[2]).toISOString(),
    // Answering before the question finished counts as zero latency.
    latencyMs: Math.max(0, t[1] - t[0]),
  });
}

/**
 * LiveKit agent session time, plus STT/TTS seconds when the agent measured them.
 * Dollars are seconds times the env rates. A later report replaces the earlier one.
 */
export async function recordSessionVoiceUsage(input: {
  sessionId: string;
  agentSeconds: number;
  sttSeconds?: number;
  ttsSeconds?: number;
}): Promise<{ voiceCostUsd: number }> {
  const db = await getDb();
  const session = await db.get<{ id: string; mode: string }>(`SELECT id, mode FROM sessions WHERE id = ?`, [
    input.sessionId,
  ]);
  if (!session || session.mode !== "defend") throw new HttpError(404, "Voice session not found");
  const agentSeconds = clampSeconds(input.agentSeconds);
  const sttSeconds = clampSeconds(input.sttSeconds ?? 0);
  const ttsSeconds = clampSeconds(input.ttsSeconds ?? 0);
  const cost = voiceCostUsd({ agentSeconds, sttSeconds, ttsSeconds });
  await db.run(
    `UPDATE sessions SET voice_agent_sec = ?, voice_stt_sec = ?, voice_tts_sec = ?, voice_cost_usd = ? WHERE id = ?`,
    [agentSeconds, sttSeconds, ttsSeconds, cost, session.id],
  );
  return { voiceCostUsd: cost };
}

function clampSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, 3 * 60 * 60);
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // Spreadsheets treat a leading = + - @, tab, or CR as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Questions for the voice interviewer: what it may say, in order, and progress. */
export async function voicePlan(sessionId: string) {
  const db = await getDb();
  const session = await db.get<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [sessionId]);
  if (!session || session.mode !== "defend" || session.channel !== "voice" || session.status !== "in_progress") {
    throw new HttpError(404, "Voice session not found");
  }
  const plan = decryptJson<InterviewPlan>(session.plan_enc, ctx.plan(session.id));
  const turns = decryptJson<TurnRecord[]>(session.transcript_enc, ctx.transcript(session.id)) ?? [];
  if (!plan) throw new HttpError(410, "This session has expired.");
  return {
    difficulty: plan.difficulty,
    probes: publicProbes(plan).map((p) => ({ id: p.id, type: p.type, question: p.question })),
    answered: turns.length,
  };
}

async function storeAnswer(
  session: SessionRow,
  probeId: string,
  rawAnswer: string,
  timing?: { startedAt: string; endedAt: string; latencyMs: number },
) {
  if (session.status !== "in_progress") throw new HttpError(409, "This defense is already complete.");
  const plan = decryptJson<InterviewPlan>(session.plan_enc, ctx.plan(session.id));
  if (!plan) throw new HttpError(410, "This session has expired. Start a new defense.");
  const turns = decryptJson<TurnRecord[]>(session.transcript_enc, ctx.transcript(session.id)) ?? [];
  const answer = rawAnswer.trim().slice(0, 4000);
  if (!answer) throw new HttpError(400, "Answer is empty.");

  const progress = (rows: TurnRecord[], idempotent = false) => {
    const upcoming = publicProbes(plan)[rows.length];
    return {
      answered: rows.length,
      total: plan.probes.length,
      done: rows.length >= plan.probes.length,
      ...(upcoming ? { nextProbe: upcoming } : {}),
      ...(idempotent ? { idempotent: true } : {}),
    };
  };

  // Same answer saved twice (a retry after a dropped response) is success.
  // A different answer for a question already stored is refused.
  const prior = turns.find((t) => t.probeId === probeId);
  if (prior) {
    if (prior.answer === answer) return progress(turns, true);
    throw new HttpError(409, "That question is already answered.");
  }

  const probe = plan.probes[turns.length];
  if (!probe) throw new HttpError(409, "All questions are already answered.");
  if (probe.id !== probeId) throw new HttpError(409, "Answer the current question first.");

  const now = new Date();
  const startedAt = timing?.startedAt ?? (turns.length ? turns[turns.length - 1].endedAt : session.started_at);
  const endedAt = timing?.endedAt ?? now.toISOString();
  turns.push({
    id: `turn_${turns.length + 1}`,
    probeId: probe.id,
    question: probe.question,
    answer,
    startedAt,
    endedAt,
    latencyMs: timing?.latencyMs ?? Math.max(0, now.getTime() - new Date(startedAt).getTime()),
    followUpIndex: probe.followUpOf ? 1 : 0,
  });

  // Optimistic concurrency: the stored ciphertext doubles as a version, so a
  // double-submitted answer can't be recorded twice.
  const db = await getDb();
  const saved = await db.run(
    `UPDATE sessions SET transcript_enc = ? WHERE id = ? AND transcript_enc = ? AND status = 'in_progress'`,
    [encryptJson(turns, ctx.transcript(session.id)), session.id, session.transcript_enc],
  );
  if (saved.changes !== 1) {
    const fresh = await db.get<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [session.id]);
    const freshTurns = decryptJson<TurnRecord[]>(fresh?.transcript_enc, ctx.transcript(session.id)) ?? [];
    const raced = freshTurns.find((t) => t.probeId === probe.id);
    if (raced?.answer === answer) return progress(freshTurns, true);
    throw new HttpError(409, "That answer was already recorded.");
  }
  return progress(turns);
}

async function writeGradingProgress(sessionId: string, progress: GradingProgress): Promise<void> {
  try {
    const db = await getDb();
    await db.run(`UPDATE sessions SET grading_progress = ? WHERE id = ? AND status = 'grading'`, [
      JSON.stringify(progress),
      sessionId,
    ]);
  } catch (e) {
    console.error("[grading] progress", e instanceof Error ? e.message : e);
  }
}

/** Polled by the interview while the complete request is still running. */
export async function getDefendGradingProgress(sessionId: string, user: User) {
  const session = await requireOwnSession(sessionId, user, "defend");
  return {
    status: session.status,
    progress: readGradingProgress(session.grading_progress),
  };
}

export async function completeDefendSession(opts: {
  sessionId: string;
  user: User;
  /** Browser-observed signals; reported, never mixed into the score. */
  pasteEvents?: number;
  focusBlurEvents?: number;
  showName?: boolean;
  /**
   * When false, the deck cache starts before grading and the receipt returns
   * without waiting for the cards. The text is already copied into that job.
   * Callers that need the cards stored before this returns omit the flag.
   */
  waitForStudyDeck?: boolean;
}) {
  const session = await requireOwnSession(opts.sessionId, opts.user, "defend");
  if (session.status === "abandoned") {
    throw new HttpError(402, "This defense ended before grading. The credit was returned.");
  }
  const db = await getDb();

  const request = await db.get<RequestRow>(`SELECT * FROM defense_requests WHERE id = ?`, [
    session.request_id,
  ]);
  const deliverable = await db.get<DeliverableRow>(`SELECT * FROM deliverables WHERE id = ?`, [
    session.deliverable_id,
  ]);
  const plan = decryptJson<InterviewPlan>(session.plan_enc, ctx.plan(session.id));
  const claims = deliverable ? liveClaims(deliverable) : null;
  if (!request || !deliverable || !plan || !claims) {
    throw new HttpError(410, "This session has expired. Start a new defense.");
  }
  // A retry after a dropped response returns the receipt this session already minted.
  if (session.status === "completed") {
    const existing = await receiptForSession(db, session.id);
    if (existing) {
      await finishDefenseCredit(opts.user.id, session.id);
      await noteChallengeDefended(session.request_id, {
        sessionId: session.id,
        deliverableId: session.deliverable_id,
        receiptId: existing.payload.id,
      });
      return {
        receipt: existing,
        score: existing.payload.score,
        flagged: await sessionFlagged(db, session, plan),
        stampPath: `/api/stamp/${existing.payload.id}`,
        idempotent: true,
        challenge: await challengeCompletionHint(session.request_id),
      };
    }
  }
  await assertChallengeAllowsWork(session.request_id);
  if (session.status === "grading") {
    if (!gradingClaimIsStale(session.grading_claimed_at)) {
      throw new HttpError(409, "Grading is still running. Retry in a moment.");
    }
    const released = await db.run(
      `UPDATE sessions SET status = 'in_progress', grading_claimed_at = NULL, grading_progress = NULL WHERE id = ? AND status = 'grading'`,
      [session.id],
    );
    if (released.changes !== 1) throw new HttpError(409, "Grading is still running. Retry in a moment.");
  }
  if (request.status === "defended") {
    throw new HttpError(409, "This deliverable has already been defended.");
  }

  // Grade only what the server recorded, never a client-supplied transcript.
  const turns = decryptJson<TurnRecord[]>(session.transcript_enc, ctx.transcript(session.id)) ?? [];
  if (turns.length === 0) throw new HttpError(400, "No answers to grade.");
  if (turns.length < plan.probes.length) {
    throw new HttpError(409, "Answer every question before grading.");
  }

  // Claim the session before paying for grading, so a double submit can't grade twice.
  const claimed = await db.run(
    `UPDATE sessions SET status = 'grading', grading_claimed_at = ?, grading_progress = ? WHERE id = ? AND status = 'in_progress'`,
    [new Date().toISOString(), JSON.stringify({ done: 0, total: 0, stage: "grading" }), session.id],
  );
  if (claimed.changes !== 1) throw new HttpError(409, "This defense is already complete.");

  let signed: SignedReceipt;
  let grades: ModelGrade[];
  let integrity: ReturnType<typeof computeIntegrity>;
  try {
    // Snapshot the file text and start the deck before grading, so the model
    // call overlaps the council. The receipt route does not wait for the cards.
    await rememberStudyDeck(deliverable.id, false);
    // Graders see each claim and the answer, not the raw file.
    grades = await withLlmScope({ sessionId: session.id, requestId: session.request_id, user: opts.user }, () =>
      gradeSession(
        { difficulty: request.difficulty, claims, plan, turns },
        {
          onProgress: async (progress) => {
            await writeGradingProgress(session.id, progress);
            if (progress.modelId && progress.durationMs !== undefined) {
              await recordStageTiming({
                requestId: session.request_id,
                sessionId: session.id,
                stage: "grader",
                detail: progress.modelId,
                durationMs: progress.durationMs,
              });
            }
          },
        },
      ),
    );
    await writeGradingProgress(session.id, { done: grades.length, total: grades.length, stage: "aggregating" });
    const aggregatedAt = Date.now();
    const disputed = scoreDefense(grades, plan).disputedProbeIds;
    await recordStageTiming({
      requestId: session.request_id,
      sessionId: session.id,
      stage: "aggregation",
      durationMs: Date.now() - aggregatedAt,
    });
    const cap = await defenseCapState(session.request_id, session.id);
    const councilSize = councilMemberCount();
    const skipSecondRound =
      disputed.length > 0 && !secondRoundFits(cap.spentUsd, cap.budgetUsd, councilSize);
    if (skipSecondRound) {
      await markDefenseCapped(session.request_id, session.id, "grade_followup");
    }
    if (disputed.length > 0 && !plan.probes.some((p) => p.followUpOf) && !skipSecondRound) {
      const source = plan.probes.find((p) => p.id === disputed[0]) ?? plan.probes[0];
      const claim = claims.find((c) => c.id === source.claimId) ?? claims[0];
      const extra = makeFollowUpProbe(claim, source);
      const nextPlan: InterviewPlan = { ...plan, probes: [...plan.probes, extra] };
      const released = await db.run(
        `UPDATE sessions SET plan_enc = ?, status = 'in_progress', grading_claimed_at = NULL, grading_progress = NULL WHERE id = ? AND status = 'grading'`,
        [encryptJson(nextPlan, ctx.plan(session.id)), session.id],
      );
      if (released.changes !== 1) throw new HttpError(409, "This defense is already complete.");
      return {
        followUp: {
          probe: {
            id: extra.id,
            claimId: extra.claimId,
            type: extra.type,
            question: extra.question,
            sourceSpan: extra.sourceSpan,
          },
          answered: turns.length,
          total: nextPlan.probes.length,
        },
      };
    }
    integrity = computeIntegrity({
      turns,
      pasteEvents: opts.pasteEvents,
      focusBlurEvents: opts.focusBlurEvents,
    });
    if (opts.waitForStudyDeck !== false) await rememberStudyDeck(deliverable.id, true);
    await writeGradingProgress(session.id, { done: grades.length, total: grades.length, stage: "signing" });
    const signedAt = Date.now();
    signed = buildSignedReceipt({
      difficulty: request.difficulty,
      sha256: deliverable.sha256,
      byteLength: deliverable.byte_length,
      grades,
      integrity,
      displayName: opts.showName ? opts.user.display_name : null,
      claimScores: claimScores(grades, plan),
      interviewMode: session.channel === "voice" ? "voice" : session.channel === "text_accommodation" ? "text-accommodation" : "text",
      plan,
    });
    await recordStageTiming({
      requestId: session.request_id,
      sessionId: session.id,
      stage: "receipt_sign",
      durationMs: Date.now() - signedAt,
    });

    const nowIso = new Date().toISOString();
    await db.transaction(async (tx) => {
      // One receipt per deliverable: two parallel Defend sessions can't both mint one.
      const won = await tx.run(
        `UPDATE defense_requests SET status = 'defended' WHERE id = ? AND status <> 'defended'`,
        [request.id],
      );
      if (won.changes !== 1) throw new HttpError(409, "This deliverable has already been defended.");
      await tx.run(
        `UPDATE sessions SET integrity_json = ?, status = 'completed', completed_at = ?, grading_progress = NULL WHERE id = ?`,
        [JSON.stringify(integrity), nowIso, session.id],
      );
      for (const g of grades) {
        const gradeId = newId("grd");
        await tx.run(
          `INSERT INTO grades (id, session_id, model_id, provider, scores_enc, overall_score, temperature, seed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gradeId,
            session.id,
            g.modelId,
            g.provider,
            encryptJson(g, ctx.scores(gradeId)),
            g.overallScore,
            g.temperature ?? null,
            g.seed ?? null,
            nowIso,
          ],
        );
      }
      await tx.run(
        `INSERT INTO receipts (id, session_id, request_id, payload_json, signature, public_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [signed.payload.id, session.id, request.id, JSON.stringify(signed), signed.signature, signed.publicKey, nowIso],
      );
      // The defense is done: the document body is no longer needed.
      // The Learn deck was cached above, while this text was still readable.
      await tx.run(`UPDATE deliverables SET text_enc = NULL WHERE id = ?`, [deliverable.id]);
    });
    await noteChallengeDefended(session.request_id, {
      sessionId: session.id,
      deliverableId: deliverable.id,
      receiptId: signed.payload.id,
    });
  } catch (e) {
    // Release the claim so the creator can retry after a grading or storage failure.
    await db.run(
      `UPDATE sessions SET status = 'in_progress', grading_claimed_at = NULL, grading_progress = NULL WHERE id = ? AND status = 'grading'`,
      [session.id],
    );
    throw e;
  }

  await finishDefenseCredit(opts.user.id, session.id);
  return {
    receipt: signed,
    score: aggregateScore(grades, plan),
    flagged: shouldFlagForHuman(grades, plan) || integrity.status !== "Clear",
    stampPath: `/api/stamp/${signed.payload.id}`,
    challenge: await challengeCompletionHint(session.request_id),
  };
}

function councilMemberCount(): number {
  try {
    return getGradingCouncil().length;
  } catch {
    return 2;
  }
}

function gradingClaimIsStale(claimedAt: string | null | undefined): boolean {
  if (!claimedAt) return true;
  const taken = Date.parse(claimedAt);
  if (Number.isNaN(taken)) return true;
  return Date.now() - taken >= GRADING_CLAIM_TTL_MS;
}

/** The flag from the stored grades and integrity, so a retry reports the same one. */
async function sessionFlagged(db: Db, session: SessionRow, plan: InterviewPlan): Promise<boolean> {
  const rows = await db.all<{ id: string; scores_enc: string | null }>(
    `SELECT id, scores_enc FROM grades WHERE session_id = ?`,
    [session.id],
  );
  const grades = rows
    .map((row) => decryptJson<ModelGrade>(row.scores_enc, ctx.scores(row.id)))
    .filter((grade): grade is ModelGrade => !!grade);
  const integrity = session.integrity_json
    ? (JSON.parse(session.integrity_json) as { status?: string })
    : null;
  return shouldFlagForHuman(grades, plan) || (!!integrity?.status && integrity.status !== "Clear");
}

async function receiptForSession(db: Db, sessionId: string): Promise<SignedReceipt | null> {
  const row = await db.get<{ payload_json: string }>(`SELECT payload_json FROM receipts WHERE session_id = ?`, [sessionId]);
  return row ? (JSON.parse(row.payload_json) as SignedReceipt) : null;
}

export async function getReceipt(receiptId: string): Promise<SignedReceipt | null> {
  if (!/^rcpt_[A-Za-z0-9]{10,40}$/.test(receiptId)) return null;
  const db = await getDb();
  const row = await db.get<{ payload_json: string }>(
    `SELECT payload_json FROM receipts WHERE id = ?`,
    [receiptId],
  );
  return row ? (JSON.parse(row.payload_json) as SignedReceipt) : null;
}

/** Requests the user sent (receiver) or defended (creator), newest first. */
export async function listDashboard(user: User) {
  const db = await getDb();
  const rows = await db.all<{
    id: string;
    token: string;
    title: string;
    kind: string;
    difficulty: string;
    status: string;
    created_at: string;
    owner_user_id: string;
    creator_user_id: string | null;
    receipt_id: string | null;
    payload_json: string | null;
    deliverable_id: string | null;
    file_name_enc: string | null;
    purge_after: string | null;
    purged_at: string | null;
  }>(
    `SELECT r.id, r.token, r.title, r.kind, r.difficulty, r.status, r.created_at,
            r.owner_user_id, r.creator_user_id, rc.id AS receipt_id, rc.payload_json,
            d.id AS deliverable_id, d.file_name_enc, d.purge_after, d.purged_at
     FROM defense_requests r
     LEFT JOIN receipts rc ON rc.request_id = r.id
     LEFT JOIN deliverables d ON d.id =
       (SELECT id FROM deliverables WHERE request_id = r.id ORDER BY created_at DESC LIMIT 1)
     WHERE r.owner_user_id = ? OR r.creator_user_id = ?
     ORDER BY r.created_at DESC
     LIMIT 200`,
    [user.id, user.id],
  );
  return rows.map((r) => {
    const receipt = r.payload_json ? (JSON.parse(r.payload_json) as SignedReceipt) : null;
    const isCreator = r.creator_user_id === user.id;
    const fileName =
      isCreator && r.deliverable_id && !r.purged_at && !isPast(r.purge_after)
        ? decryptField(r.file_name_enc, ctx.fileName(r.deliverable_id))
        : null;
    return {
      token: r.token,
      title: r.kind === "creator" ? displayTitle(fileName) : r.title,
      kind: r.kind,
      role: isCreator ? "creator" : "receiver",
      difficulty: r.difficulty,
      status: r.status,
      createdAt: r.created_at,
      receiptId: r.receipt_id,
      score: receipt?.payload.score ?? null,
      outcome: receipt ? receipt.payload.outcome : null,
      workspaceHref: dashboardWorkspaceHref({
        token: r.token,
        role: isCreator ? "creator" : "receiver",
        status: r.status,
      }),
    };
  });
}

export async function listAdminSessions() {
  const db = await getDb();
  const rows = await db.all<{
    id: string;
    mode: string;
    creator_email: string;
    status: string;
    completed_at: string | null;
    title: string;
    difficulty: string;
    receipt_id: string | null;
    human_score: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cost_usd: number | null;
    over_budget: number | null;
    budget_usd: number | null;
    cost_tier: string | null;
    budget_capped: number | null;
    voice_cost_usd: number | null;
  }>(
    `SELECT s.id, s.mode, u.email AS creator_email, s.status, s.completed_at,
            r.title, r.difficulty, rc.id AS receipt_id, hg.overall_score AS human_score,
            s.prompt_tokens, s.completion_tokens, s.cost_usd, s.over_budget,
            s.budget_usd, s.cost_tier, s.budget_capped, s.voice_cost_usd
     FROM sessions s
     JOIN defense_requests r ON r.id = s.request_id
     JOIN users u ON u.id = s.user_id
     LEFT JOIN receipts rc ON rc.session_id = s.id
     LEFT JOIN human_grades hg ON hg.session_id = s.id
     WHERE s.mode = 'defend'
     ORDER BY s.started_at DESC
     LIMIT 200`,
  );
  const sessions = rows.map((row) => {
    const llmUsd = Number(row.cost_usd ?? 0);
    const voiceUsd = Number(row.voice_cost_usd ?? 0);
    const totalUsd = llmUsd + voiceUsd;
    const tier = parseCostTier(row.cost_tier);
    const budgetUsd = row.budget_usd != null ? Number(row.budget_usd) : budgetUsdForTier(tier);
    const capped = Number(row.budget_capped ?? 0) === 1;
    return {
      ...row,
      prompt_tokens: Number(row.prompt_tokens ?? 0),
      completion_tokens: Number(row.completion_tokens ?? 0),
      cost_usd: llmUsd,
      llm_cost_usd: llmUsd,
      voice_cost_usd: voiceUsd,
      total_cost_usd: totalUsd,
      over_budget: totalUsd > budgetUsd ? 1 : 0,
      budget_usd: budgetUsd,
      cost_tier: tier,
      budget_capped: capped ? 1 : 0,
    };
  });
  const recent = sessions.filter((session) => session.status === "completed" || session.receipt_id).slice(0, costReportLimit());
  const summary = summarizeCosts(
    recent.map((session) => ({
      totalUsd: session.total_cost_usd,
      llmUsd: session.llm_cost_usd,
      voiceUsd: session.voice_cost_usd,
      capped: session.budget_capped === 1,
    })),
  );
  return { sessions, summary };
}

export function adminSessionsCsv(
  sessions: {
    id: string;
    title: string;
    creator_email: string;
    difficulty: string;
    status: string;
    cost_tier: CostTier;
    budget_usd: number;
    llm_cost_usd: number;
    voice_cost_usd: number;
    total_cost_usd: number;
    budget_capped: number;
  }[],
): string {
  const header = [
    "id",
    "title",
    "creator",
    "difficulty",
    "status",
    "tier",
    "budget_usd",
    "llm_usd",
    "voice_usd",
    "total_usd",
    "capped",
  ];
  const lines = sessions.map((session) =>
    [
      session.id,
      session.title,
      session.creator_email,
      session.difficulty,
      session.status,
      session.cost_tier,
      session.budget_usd,
      session.llm_cost_usd,
      session.voice_cost_usd,
      session.total_cost_usd,
      session.budget_capped,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export async function getAdminSessionDetail(sessionId: string) {
  const db = await getDb();
  const session = await db.get<
    SessionRow & {
      creator_email: string;
      display_name: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      cost_usd: number | null;
      budget_usd: number | null;
      cost_tier: string | null;
      budget_capped: number | null;
      voice_cost_usd: number | null;
      voice_agent_sec: number | null;
      voice_stt_sec: number | null;
      voice_tts_sec: number | null;
    }
  >(
    `SELECT s.*, u.email AS creator_email, u.display_name FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    [sessionId],
  );
  if (!session) return null;
  const tier = parseCostTier(session.cost_tier);
  const budgetUsd =
    session.budget_usd != null && Number.isFinite(Number(session.budget_usd))
      ? Number(session.budget_usd)
      : budgetUsdForTier(tier);
  const llmUsd = Number(session.cost_usd ?? 0);
  const voiceUsd = Number(session.voice_cost_usd ?? 0);
  const totalUsd = llmUsd + voiceUsd;
  const capped = Number(session.budget_capped ?? 0) === 1;
  const calls = await db.all<{
    id: string;
    purpose: string | null;
    provider: string;
    model_id: string;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
    cost_source: "provider" | "estimated";
  }>(
    `SELECT id, purpose, provider, model_id, prompt_tokens, completion_tokens, cost_usd, cost_source
     FROM llm_calls
     WHERE ${session.mode === "defend" ? "request_id = ?" : "session_id = ?"}
     ORDER BY created_at, id`,
    [session.mode === "defend" ? session.request_id : session.id],
  );
  const grades = await db.all<{ id: string; scores_enc: string | null }>(
    `SELECT id, scores_enc FROM grades WHERE session_id = ?`,
    [sessionId],
  );
  const human = await db.get<{ overall_score: number; notes: string | null; grader_name: string }>(
    `SELECT overall_score, notes, grader_name FROM human_grades WHERE session_id = ?`,
    [sessionId],
  );
  const receipt = await db.get<{ payload_json: string }>(
    `SELECT payload_json FROM receipts WHERE session_id = ?`,
    [sessionId],
  );
  return {
    session: {
      id: session.id,
      mode: session.mode,
      status: session.status,
      creator_email: session.creator_email,
      creator_name: session.display_name,
      transcript: decryptJson<TurnRecord[]>(session.transcript_enc, ctx.transcript(session.id)),
      integrity: session.integrity_json ? JSON.parse(session.integrity_json) : null,
      purged: !session.transcript_enc,
    },
    grades: grades
      .map((g) => decryptJson<ModelGrade>(g.scores_enc, ctx.scores(g.id)))
      .filter((g): g is ModelGrade => !!g),
    human,
    receipt: receipt ? (JSON.parse(receipt.payload_json) as SignedReceipt) : null,
    usage: {
      promptTokens: Number(session.prompt_tokens ?? 0),
      completionTokens: Number(session.completion_tokens ?? 0),
      costUsd: llmUsd,
      llmUsd,
      voiceUsd,
      totalUsd,
      voice: {
        agentSeconds: Number(session.voice_agent_sec ?? 0),
        sttSeconds: Number(session.voice_stt_sec ?? 0),
        ttsSeconds: Number(session.voice_tts_sec ?? 0),
      },
      tier,
      capped,
      overBudget: totalUsd > budgetUsd,
      budgetUsd,
      calls: calls.map((call) => ({
        id: call.id,
        purpose: call.purpose,
        provider: call.provider,
        modelId: call.model_id,
        promptTokens: Number(call.prompt_tokens),
        completionTokens: Number(call.completion_tokens),
        costUsd: Number(call.cost_usd),
        costSource: call.cost_source,
      })),
    },
    timings: await listStageTimings({ requestId: session.request_id, sessionId }),
  };
}

export async function saveHumanGrade(opts: {
  sessionId: string;
  overallScore: number;
  notes?: string;
  graderName: string;
}) {
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const id = newId("hum");
  await db.run(
    `INSERT INTO human_grades (id, session_id, overall_score, notes, grader_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       overall_score = excluded.overall_score, notes = excluded.notes,
       grader_name = excluded.grader_name, created_at = excluded.created_at`,
    [id, opts.sessionId, opts.overallScore, opts.notes || null, opts.graderName, nowIso],
  );
}

/**
 * Section plus the cited source span, for the creator only and only while the
 * defense data is within retention. The public receipt stays anonymous.
 */
export async function receiptClaimLabels(receiptId: string, user: User): Promise<string[] | null> {
  const db = await getDb();
  const row = await db.get<SessionRow & { deliverable_ref: string }>(
    `SELECT s.*, s.deliverable_id AS deliverable_ref FROM receipts r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?`,
    [receiptId],
  );
  if (!row || row.user_id !== user.id || isPast(row.purge_after)) return null;
  const plan = decryptJson<InterviewPlan>(row.plan_enc, ctx.plan(row.id));
  const deliverable = await db.get<DeliverableRow>(`SELECT * FROM deliverables WHERE id = ?`, [row.deliverable_ref]);
  const claims = deliverable ? liveClaims(deliverable) : null;
  if (!plan || !claims) return null;
  const order = [...new Set(plan.probes.map((p) => p.claimId))];
  return order.map((id) => {
    const claim = claims.find((c) => c.id === id);
    const probe = plan.probes.find((p) => p.claimId === id);
    if (!claim) return "Claim";
    const span = (probe?.sourceSpan || claim.sourceSpan || "").replace(/\s+/g, " ").trim();
    const short = span.length > 60 ? `${span.slice(0, 59)}…` : span;
    return short ? `${claim.section}: ${short}` : claim.section;
  });
}

/** The signed-in creator's own deliverable behind a link, with live claims (for Learn tools). */
export async function loadOwnDeliverable(token: string, user: User) {
  const request = await requireRequest(token);
  if (request.creator_user_id !== user.id) {
    throw new HttpError(403, "This defense belongs to another account");
  }
  const deliverable = await getLatestDeliverable(request.id);
  if (!deliverable) throw new HttpError(400, "Upload a deliverable first");
  const claims = liveClaims(deliverable);
  if (!claims) throw new HttpError(410, "This upload has been purged. Upload the file again.");
  return {
    request,
    deliverable,
    claims,
    text: liveText(deliverable),
    fileName: liveFileName(deliverable),
  };
}

/** Learn hub: the creator's deliverables with what they can still do with each. */
export async function listProjects(user: User) {
  const db = await getDb();
  const rows = await db.all<DeliverableRow & { token: string; status: string; difficulty: string; cards: number; due: number }>(
    `SELECT d.*, r.token, r.status, r.difficulty,
            (SELECT COUNT(*) FROM flashcards f WHERE f.deliverable_id = d.id) AS cards,
            (SELECT COUNT(*) FROM flashcards f WHERE f.deliverable_id = d.id AND f.due <= ?) AS due
     FROM defense_requests r
     JOIN deliverables d ON d.id =
       (SELECT id FROM deliverables WHERE request_id = r.id ORDER BY created_at DESC LIMIT 1)
     WHERE r.creator_user_id = ? AND r.learn_closed_at IS NULL
     ORDER BY d.created_at DESC
     LIMIT 100`,
    [new Date().toISOString(), user.id],
  );
  return rows.map((d) => {
    const purged = !!d.purged_at || isPast(d.purge_after);
    return {
      token: d.token,
      title: displayTitle(purged ? null : liveFileName(d)),
      status: d.status,
      difficulty: d.difficulty,
      claimCount: d.claim_count,
      createdAt: d.created_at,
      documentAvailable: !purged && !!d.text_enc && !isPast(d.text_purge_after),
      purged,
      cards: Number(d.cards),
      due: Number(d.due),
    };
  });
}

/**
 * flashcards.ts reads deliverables through this module. A static import would
 * cycle on load, so the deck cache is imported at the moment text is deleted.
 */
async function rememberStudyDeck(deliverableId: string, waitForCards: boolean): Promise<void> {
  const { beginStudyDeckCache } = await import("./flashcards");
  try {
    const job = beginStudyDeckCache(deliverableId);
    await job.snapshotted;
    if (waitForCards) await job.done;
  } catch (e) {
    console.warn(
      "[flashcards] deck was not cached before document text was deleted:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** Delete expired content. Safe to run often: daily cron plus an hourly in-process backstop. */
export async function purgeExpired() {
  const db = await getDb();
  await expireDueChallenges(db);
  const nowIso = new Date().toISOString();
  // Full retention (purge_after) deletes the deck in this same run, so only
  // cache when the text timer is up and the deliverable itself is still kept.
  const expiring = await db.all<{ id: string }>(
    `SELECT id FROM deliverables
     WHERE text_enc IS NOT NULL AND text_purge_after < ? AND purge_after >= ?`,
    [nowIso, nowIso],
  );
  for (const row of expiring) await rememberStudyDeck(row.id, true);
  const text = await db.run(
    `UPDATE deliverables SET text_enc = NULL WHERE text_enc IS NOT NULL AND text_purge_after < ?`,
    [nowIso],
  );
  const deliverables = await db.run(
    `UPDATE deliverables SET file_name_enc = NULL, text_enc = NULL, claims_enc = NULL, purged_at = ?
     WHERE purged_at IS NULL AND purge_after < ?`,
    [nowIso, nowIso],
  );
  const sessions = await db.run(
    `UPDATE sessions SET plan_enc = NULL, transcript_enc = NULL, gap_map_enc = NULL
     WHERE (plan_enc IS NOT NULL OR transcript_enc IS NOT NULL) AND purge_after < ?`,
    [nowIso],
  );
  await db.run(
    `UPDATE grades SET scores_enc = NULL WHERE scores_enc IS NOT NULL AND session_id IN
       (SELECT id FROM sessions WHERE purge_after < ?)`,
    [nowIso],
  );
  await db.run(
    `UPDATE human_grades SET notes = NULL WHERE notes IS NOT NULL AND session_id IN
       (SELECT id FROM sessions WHERE purge_after < ?)`,
    [nowIso],
  );
  await db.run(`DELETE FROM flashcards WHERE purge_after < ?`, [nowIso]);
  await db.run(`DELETE FROM login_tokens WHERE expires_at < ?`, [nowIso]);
  await db.run(`DELETE FROM auth_sessions WHERE expires_at < ?`, [nowIso]);
  await db.run(`DELETE FROM rate_limits WHERE window_start < ?`, [
    new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
  ]);
  await refundStaleDefenseHolds();
  return {
    documentTexts: text.changes,
    deliverables: deliverables.changes,
    sessions: sessions.changes,
  };
}

export function publicKeyInfo() {
  return {
    publicKeyHex: getPublicKeyHex(),
    algorithm: "Ed25519",
    llmMode: llmModeLabel(),
    gradingCouncil: describeGradingCouncil(),
  };
}
