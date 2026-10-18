import type { User } from "./auth";
import { extractClaims } from "./claims";
import { getPublicKeyHex, sha256Hex } from "./crypto";
import { getDb, type Db } from "./db";
import { aggregateScore, gradeSession, shouldFlagForHuman } from "./grading";
import { HttpError } from "./http";
import { newId, newToken } from "./ids";
import { computeIntegrity } from "./integrity";
import { nextLearnTurn, type GapItem } from "./learn";
import { llmModeLabel } from "./llm";
import { extractText, guessMimeType } from "./parse";
import { buildInterviewPlan, buildLearnPlan } from "./probes";
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
  const plan =
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

  const sessionId = newId("ses");
  const db = await getDb();
  await db.run(
    `INSERT INTO sessions
      (id, request_id, deliverable_id, user_id, mode, seed, plan_enc, transcript_enc, gap_map_enc, status, started_at, purge_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
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
    ],
  );
  return { sessionId, plan };
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
 * Keep only answers to probes in the server-side plan, and use the plan's own
 * question text, so a client can't swap in easier questions.
 */
export function reconcileTurns(plan: InterviewPlan, turns: TurnRecord[]): TurnRecord[] {
  const byId = new Map(plan.probes.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: TurnRecord[] = [];
  for (const t of turns) {
    const probe = byId.get(t.probeId);
    if (!probe) continue;
    const key = `${t.probeId}:${t.followUpIndex ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...t,
      question: probe.question,
      answer: String(t.answer ?? "").slice(0, 4000),
      latencyMs: Math.max(0, Number(t.latencyMs) || 0),
    });
  }
  return out;
}

export async function completeDefendSession(opts: {
  sessionId: string;
  user: User;
  turns: TurnRecord[];
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
  if (request.status === "defended") {
    throw new HttpError(409, "This deliverable has already been defended.");
  }

  const turns = reconcileTurns(plan, opts.turns);
  if (turns.length === 0) throw new HttpError(400, "No answers to grade.");

  // Claim the session before paying for grading, so a double submit can't grade twice.
  const claimed = await db.run(
    `UPDATE sessions SET status = 'grading' WHERE id = ? AND status = 'in_progress'`,
    [session.id],
  );
  if (claimed.changes !== 1) throw new HttpError(409, "This defense is already complete.");

  let signed: SignedReceipt;
  let grades: ModelGrade[];
  let integrity: ReturnType<typeof computeIntegrity>;
  try {
    // Grading sees probe metadata and answers only, never the document text.
    grades = await gradeSession({ difficulty: request.difficulty, claims, plan, turns });
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
        `UPDATE sessions SET transcript_enc = ?, integrity_json = ?, status = 'completed', completed_at = ?
         WHERE id = ?`,
        [encryptJson(turns, ctx.transcript(session.id)), JSON.stringify(integrity), nowIso, session.id],
      );
      for (const g of grades) {
        const gradeId = newId("grd");
        await tx.run(
          `INSERT INTO grades (id, session_id, model_id, provider, scores_enc, overall_score, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [gradeId, session.id, g.modelId, g.provider, encryptJson(g, ctx.scores(gradeId)), g.overallScore, nowIso],
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
    await db.run(`UPDATE sessions SET status = 'in_progress' WHERE id = ? AND status = 'grading'`, [session.id]);
    throw e;
  }

  return {
    receipt: signed,
    score: aggregateScore(grades),
    flagged: shouldFlagForHuman(grades) || integrity.status !== "Clear",
    stampPath: `/api/stamp/${signed.payload.id}`,
  };
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
  };
}
