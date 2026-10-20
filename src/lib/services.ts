import type { User } from "./auth";
import { extractClaims } from "./claims";
import { getPublicKeyHex, sha256Hex } from "./crypto";
import { getDb, type Db } from "./db";
import { aggregateScore, claimScores, gradeSession, scoreDefense, shouldFlagForHuman } from "./grading";
import { HttpError } from "./http";
import { newId, newToken } from "./ids";
import { computeIntegrity } from "./integrity";
import { nextLearnTurn, type GapItem } from "./learn";
import { describeGradingCouncil, llmModeLabel } from "./llm";
import { extractText, guessMimeType } from "./parse";
import { buildInterviewPlan, buildLearnPlan, makeFollowUpProbe } from "./probes";
import { phraseQuestions } from "./questions";
import { buildSignedReceipt } from "./receipt";
import type {
  Claim,
  Difficulty,
  InterviewPlan,
  ModelGrade,
  SignedReceipt,
  TurnRecord,
} from "./types";
import { decryptField, decryptJson, encryptField, encryptJson } from "./vault";

/**
 * Data lifecycle ("process and purge"):
 * - Raw upload bytes are parsed in memory and never stored; only the SHA-256 is kept.
 * - Extracted document text is encrypted and deleted when the defense completes,
 *   or after DOCUMENT_TTL_HOURS for Learn-only use.
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
}

/** Parse and extract claims before anything is written, so failures leave no rows behind. */
async function prepareUpload(fileName: string, buffer: Buffer, mimeType?: string): Promise<PreparedUpload> {
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
  return { fileName, mime, sha256: sha256Hex(buffer), byteLength: buffer.length, text, claims };
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
  const upload = await prepareUpload(opts.fileName, opts.buffer, opts.mimeType);
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const created = await insertRequest(tx, {
      owner: opts.user,
      kind: "creator",
      difficulty: opts.difficulty || "hard",
      title: PRIVATE_TITLE,
    });
    const deliverableId = await insertDeliverable(tx, created.requestId, opts.user, upload);
    await tx.run(`UPDATE defense_requests SET status = 'uploaded' WHERE id = ?`, [created.requestId]);
    return { ...created, deliverableId };
  });
  return {
    ...result,
    sha256: upload.sha256,
    claimCount: upload.claims.length,
    textLength: upload.text.length,
    title: displayTitle(opts.fileName),
  };
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
      purged: boolean;
    },
  };
  if (isCreator || isOwner) {
    const d = await getLatestDeliverable(request.id);
    if (d) {
      const fileName = liveFileName(d);
      const purged = !!d.purged_at || isPast(d.purge_after);
      view.deliverable = {
        fileName,
        sha256: d.sha256,
        byteLength: d.byte_length,
        claimCount: d.claim_count,
        documentAvailable: !purged && !!d.text_enc && !isPast(d.text_purge_after),
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

  const upload = await prepareUpload(opts.fileName, opts.buffer, opts.mimeType);
  const db = await getDb();
  const deliverableId = await db.transaction(async (tx) => {
    if (claiming) {
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

export async function startSession(opts: {
  token: string;
  user: User;
  mode: "learn" | "defend";
  voice?: boolean;
  accommodation?: boolean;
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

  const seed = newId("seed");
  const drafted =
    opts.mode === "learn"
      ? buildLearnPlan(claims, seed)
      : buildInterviewPlan({
          claims,
          difficulty: request.difficulty,
          seed,
          pinnedClaimIds: request.pinned_claims
            ? request.pinned_claims.split(",").map((s) => s.trim())
            : undefined,
        });
  // Defend questions are written for this specific file (code still picks what to probe).
  const plan = opts.mode === "defend" ? await phraseQuestions(drafted, claims) : drafted;
  const channel: Channel = opts.mode === "defend" ? channelFor(request.difficulty, opts) : "text";

  const sessionId = newId("ses");
  const db = await getDb();
  await db.run(
    `INSERT INTO sessions
      (id, request_id, deliverable_id, user_id, mode, seed, plan_enc, transcript_enc, gap_map_enc, status, started_at, purge_after, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
    [
      sessionId,
      request.id,
      deliverable.id,
      opts.user.id,
      opts.mode,
      seed,
      encryptJson(plan, ctx.plan(sessionId)),
      encryptJson([], ctx.transcript(sessionId)),
      encryptJson([], ctx.gapMap(sessionId)),
      new Date().toISOString(),
      hoursFromNow(retentionDays() * 24),
      channel,
    ],
  );
  return { sessionId, plan, channel };
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

  const result = await nextLearnTurn({
    documentExcerpt: text,
    claims,
    history,
    turnIndex: history.filter((h) => h.role === "creator").length + 1,
  });

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

  const progress = (rows: TurnRecord[], idempotent = false) => ({
    answered: rows.length,
    total: plan.probes.length,
    done: rows.length >= plan.probes.length,
    ...(idempotent ? { idempotent: true } : {}),
  });

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

export async function completeDefendSession(opts: {
  sessionId: string;
  user: User;
  /** Browser-observed signals; reported, never mixed into the score. */
  pasteEvents?: number;
  focusBlurEvents?: number;
  showName?: boolean;
}) {
  const session = await requireOwnSession(opts.sessionId, opts.user, "defend");
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
      return {
        receipt: existing,
        score: existing.payload.score,
        flagged: await sessionFlagged(db, session, plan),
        stampPath: `/api/stamp/${existing.payload.id}`,
        idempotent: true,
      };
    }
  }
  if (session.status === "grading") {
    if (!gradingClaimIsStale(session.grading_claimed_at)) {
      throw new HttpError(409, "Grading is still running. Retry in a moment.");
    }
    const released = await db.run(
      `UPDATE sessions SET status = 'in_progress', grading_claimed_at = NULL WHERE id = ? AND status = 'grading'`,
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
    `UPDATE sessions SET status = 'grading', grading_claimed_at = ? WHERE id = ? AND status = 'in_progress'`,
    [new Date().toISOString(), session.id],
  );
  if (claimed.changes !== 1) throw new HttpError(409, "This defense is already complete.");

  let signed: SignedReceipt;
  let grades: ModelGrade[];
  let integrity: ReturnType<typeof computeIntegrity>;
  try {
    // Graders see each claim and the answer, not the raw file.
    grades = await gradeSession({ difficulty: request.difficulty, claims, plan, turns });
    const disputed = scoreDefense(grades, plan).disputedProbeIds;
    if (disputed.length > 0 && !plan.probes.some((p) => p.followUpOf)) {
      const source = plan.probes.find((p) => p.id === disputed[0]) ?? plan.probes[0];
      const claim = claims.find((c) => c.id === source.claimId) ?? claims[0];
      const extra = makeFollowUpProbe(claim, source);
      const nextPlan: InterviewPlan = { ...plan, probes: [...plan.probes, extra] };
      const released = await db.run(
        `UPDATE sessions SET plan_enc = ?, status = 'in_progress', grading_claimed_at = NULL WHERE id = ? AND status = 'grading'`,
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

    const nowIso = new Date().toISOString();
    await db.transaction(async (tx) => {
      // One receipt per deliverable: two parallel Defend sessions can't both mint one.
      const won = await tx.run(
        `UPDATE defense_requests SET status = 'defended' WHERE id = ? AND status <> 'defended'`,
        [request.id],
      );
      if (won.changes !== 1) throw new HttpError(409, "This deliverable has already been defended.");
      await tx.run(
        `UPDATE sessions SET integrity_json = ?, status = 'completed', completed_at = ? WHERE id = ?`,
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
      await tx.run(`UPDATE deliverables SET text_enc = NULL WHERE id = ?`, [deliverable.id]);
    });
  } catch (e) {
    // Release the claim so the creator can retry after a grading or storage failure.
    await db.run(
      `UPDATE sessions SET status = 'in_progress', grading_claimed_at = NULL WHERE id = ? AND status = 'grading'`,
      [session.id],
    );
    throw e;
  }

  return {
    receipt: signed,
    score: aggregateScore(grades, plan),
    flagged: shouldFlagForHuman(grades, plan) || integrity.status !== "Clear",
    stampPath: `/api/stamp/${signed.payload.id}`,
  };
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
    };
  });
}

export async function listAdminSessions() {
  const db = await getDb();
  return db.all<{
    id: string;
    mode: string;
    creator_email: string;
    status: string;
    completed_at: string | null;
    title: string;
    difficulty: string;
    receipt_id: string | null;
    human_score: number | null;
  }>(
    `SELECT s.id, s.mode, u.email AS creator_email, s.status, s.completed_at,
            r.title, r.difficulty, rc.id AS receipt_id, hg.overall_score AS human_score
     FROM sessions s
     JOIN defense_requests r ON r.id = s.request_id
     JOIN users u ON u.id = s.user_id
     LEFT JOIN receipts rc ON rc.session_id = s.id
     LEFT JOIN human_grades hg ON hg.session_id = s.id
     WHERE s.mode = 'defend'
     ORDER BY s.started_at DESC
     LIMIT 200`,
  );
}

export async function getAdminSessionDetail(sessionId: string) {
  const db = await getDb();
  const session = await db.get<SessionRow & { creator_email: string; display_name: string | null }>(
    `SELECT s.*, u.email AS creator_email, u.display_name FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    [sessionId],
  );
  if (!session) return null;
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
  return { request, deliverable, claims };
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
     WHERE r.creator_user_id = ?
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

/** Delete expired content. Safe to run often: daily cron plus an hourly in-process backstop. */
export async function purgeExpired() {
  const db = await getDb();
  const nowIso = new Date().toISOString();
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
