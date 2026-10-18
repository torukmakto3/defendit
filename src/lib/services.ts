import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { extractClaims } from "./claims";
import { getPublicKeyHex, sha256Hex } from "./crypto";
import { getDb } from "./db";
import {
  aggregateScore,
  gradeSession,
  shouldFlagForHuman,
} from "./grading";
import { newId, newToken } from "./ids";
import { computeIntegrity } from "./integrity";
import { nextLearnTurn, type GapItem } from "./learn";
import { llmModeLabel } from "./llm";
import { extractTextFromFile, guessMimeType } from "./parse";
import { buildInterviewPlan, buildLearnPlan } from "./probes";
import { buildSignedReceipt } from "./receipt";
import { generateStampSvg } from "./stamp";
import type {
  Claim,
  Difficulty,
  InterviewPlan,
  ModelGrade,
  SignedReceipt,
  TurnRecord,
} from "./types";

export function createDefenseRequest(input: {
  receiverName: string;
  receiverEmail: string;
  difficulty: Difficulty;
  title: string;
  notes?: string;
  pinnedClaims?: string;
}) {
  const db = getDb();
  const receiverId = newId("rcv");
  const requestId = newId("req");
  const token = newToken();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO receivers (id, name, email, created_at) VALUES (?, ?, ?, ?)`,
  ).run(receiverId, input.receiverName, input.receiverEmail, now);

  db.prepare(
    `INSERT INTO defense_requests
      (id, token, receiver_id, difficulty, title, notes, pinned_claims, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    requestId,
    token,
    receiverId,
    input.difficulty,
    input.title,
    input.notes || null,
    input.pinnedClaims || null,
    now,
  );

  return { requestId, token, receiverId };
}

/**
 * Creator-driven entry: drop a file, we mint a self-request token,
 * then Learn / Defend can start immediately.
 */
export async function creatorIngest(opts: {
  fileName: string;
  buffer: Buffer;
  creatorName: string;
  creatorEmail: string;
  difficulty?: Difficulty;
  mimeType?: string;
}) {
  const title = opts.fileName.replace(/\.[^.]+$/, "") || "Untitled deliverable";
  const created = createDefenseRequest({
    receiverName: opts.creatorName,
    receiverEmail: opts.creatorEmail,
    difficulty: opts.difficulty || "hard",
    title,
    notes: "Self-initiated creator defense",
  });

  const uploaded = await ingestDeliverable({
    token: created.token,
    fileName: opts.fileName,
    buffer: opts.buffer,
    creatorName: opts.creatorName,
    creatorEmail: opts.creatorEmail,
    mimeType: opts.mimeType,
  });

  return {
    ...created,
    ...uploaded,
    title,
  };
}

export function getRequestByToken(token: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT r.*, rv.name as receiver_name, rv.email as receiver_email
       FROM defense_requests r
       JOIN receivers rv ON rv.id = r.receiver_id
       WHERE r.token = ?`,
    )
    .get(token) as
    | {
        id: string;
        token: string;
        difficulty: Difficulty;
        title: string;
        notes: string | null;
        pinned_claims: string | null;
        status: string;
        receiver_name: string;
        receiver_email: string;
        created_at: string;
      }
    | undefined;
}

export async function ingestDeliverable(opts: {
  token: string;
  fileName: string;
  buffer: Buffer;
  creatorName: string;
  creatorEmail: string;
  mimeType?: string;
}) {
  const request = getRequestByToken(opts.token);
  if (!request) throw new Error("Request not found");

  const mime = opts.mimeType || guessMimeType(opts.fileName);
  const sha256 = sha256Hex(opts.buffer);
  const deliverableId = newId("del");
  const storagePath = join(
    process.cwd(),
    "uploads",
    `${deliverableId}-${opts.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
  );
  mkdirSync(join(process.cwd(), "uploads"), { recursive: true });
  writeFileSync(storagePath, opts.buffer);

  const text = await extractTextFromFile(storagePath, mime, opts.fileName);
  if (!text || text.length < 20) {
    throw new Error("Could not extract enough text from the upload.");
  }

  const claims = await extractClaims(text);
  const now = new Date().toISOString();
  const db = getDb();

  db.prepare(
    `INSERT INTO deliverables
      (id, request_id, file_name, mime_type, byte_length, sha256, storage_path, text_content, claims_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    deliverableId,
    request.id,
    opts.fileName,
    mime,
    opts.buffer.length,
    sha256,
    storagePath,
    text,
    JSON.stringify(claims),
    now,
  );

  db.prepare(`UPDATE defense_requests SET status = 'uploaded' WHERE id = ?`).run(
    request.id,
  );

  return {
    deliverableId,
    sha256,
    claims,
    textLength: text.length,
    creatorName: opts.creatorName,
    creatorEmail: opts.creatorEmail,
  };
}

export function getLatestDeliverable(requestId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM deliverables WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(requestId) as
    | {
        id: string;
        request_id: string;
        file_name: string;
        mime_type: string;
        byte_length: number;
        sha256: string;
        storage_path: string;
        text_content: string;
        claims_json: string;
      }
    | undefined;
}

export function startSession(opts: {
  token: string;
  mode: "learn" | "defend";
  creatorName: string;
  creatorEmail: string;
}) {
  const request = getRequestByToken(opts.token);
  if (!request) throw new Error("Request not found");
  const deliverable = getLatestDeliverable(request.id);
  if (!deliverable) throw new Error("Upload a deliverable first");

  const claims = JSON.parse(deliverable.claims_json) as Claim[];
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
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions
        (id, request_id, deliverable_id, mode, seed, creator_name, creator_email, plan_json, transcript_json, gap_map_json, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'in_progress', ?)`,
    )
    .run(
      sessionId,
      request.id,
      deliverable.id,
      opts.mode,
      seed,
      opts.creatorName,
      opts.creatorEmail,
      JSON.stringify(plan),
      now,
    );

  return { sessionId, plan, claims, deliverable };
}

export function getSession(sessionId: string) {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
    | {
        id: string;
        request_id: string;
        deliverable_id: string;
        mode: "learn" | "defend";
        seed: string;
        creator_name: string;
        creator_email: string;
        plan_json: string;
        transcript_json: string;
        gap_map_json: string | null;
        integrity_json: string | null;
        status: string;
      }
    | undefined;
}

export async function learnCoachTurn(opts: {
  sessionId: string;
  answer?: string;
}) {
  const session = getSession(opts.sessionId);
  if (!session || session.mode !== "learn") throw new Error("Learn session not found");

  const deliverable = getDb()
    .prepare(`SELECT * FROM deliverables WHERE id = ?`)
    .get(session.deliverable_id) as {
    text_content: string;
    claims_json: string;
  };

  const claims = JSON.parse(deliverable.claims_json) as Claim[];
  const history = JSON.parse(session.transcript_json || "[]") as {
    role: "coach" | "creator";
    content: string;
  }[];
  const gaps = JSON.parse(session.gap_map_json || "[]") as GapItem[];

  if (opts.answer) {
    history.push({ role: "creator", content: opts.answer });
  }

  const result = await nextLearnTurn({
    documentExcerpt: deliverable.text_content,
    claims,
    history,
    turnIndex: history.filter((h) => h.role === "creator").length + 1,
  });

  history.push({ role: "coach", content: result.coachMessage });
  if (result.gapHint) gaps.push(result.gapHint);

  getDb()
    .prepare(
      `UPDATE sessions SET transcript_json = ?, gap_map_json = ?, status = ? WHERE id = ?`,
    )
    .run(
      JSON.stringify(history),
      JSON.stringify(gaps),
      result.done ? "completed" : "in_progress",
      opts.sessionId,
    );

  return { ...result, gaps, history };
}

export async function completeDefendSession(opts: {
  sessionId: string;
  turns: TurnRecord[];
  pasteEvents?: number;
  focusBlurEvents?: number;
}) {
  const session = getSession(opts.sessionId);
  if (!session || session.mode !== "defend") {
    throw new Error("Defend session not found");
  }

  const request = getDb()
    .prepare(`SELECT * FROM defense_requests WHERE id = ?`)
    .get(session.request_id) as { id: string; difficulty: Difficulty };

  const deliverable = getDb()
    .prepare(`SELECT * FROM deliverables WHERE id = ?`)
    .get(session.deliverable_id) as {
    id: string;
    file_name: string;
    sha256: string;
    byte_length: number;
    claims_json: string;
  };

  const claims = JSON.parse(deliverable.claims_json) as Claim[];
  const plan = JSON.parse(session.plan_json) as InterviewPlan;
  const grades = await gradeSession({
    difficulty: request.difficulty,
    claims,
    plan,
    turns: opts.turns,
  });

  const integrity = computeIntegrity({
    turns: opts.turns,
    pasteEvents: opts.pasteEvents,
    focusBlurEvents: opts.focusBlurEvents,
  });

  const signed = buildSignedReceipt({
    requestId: request.id,
    sessionId: session.id,
    difficulty: request.difficulty,
    creatorName: session.creator_name,
    creatorEmail: session.creator_email,
    fileName: deliverable.file_name,
    sha256: deliverable.sha256,
    byteLength: deliverable.byte_length,
    claims,
    grades,
    turns: opts.turns,
    integrity,
  });

  const stamp = await generateStampSvg({
    receiptId: signed.payload.id,
    score: signed.payload.score,
    difficulty: request.difficulty,
    verifyUrl: signed.verifyUrl,
  });

  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE sessions SET transcript_json = ?, integrity_json = ?, status = 'completed', completed_at = ? WHERE id = ?`,
  ).run(JSON.stringify(opts.turns), JSON.stringify(integrity), now, session.id);

  for (const g of grades) {
    db.prepare(
      `INSERT INTO grades (id, session_id, model_id, provider, scores_json, overall_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("grd"),
      session.id,
      g.modelId,
      g.provider,
      JSON.stringify(g),
      g.overallScore,
      now,
    );
  }

  db.prepare(
    `INSERT INTO receipts (id, session_id, request_id, payload_json, signature, public_key, stamp_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    signed.payload.id,
    session.id,
    request.id,
    JSON.stringify(signed),
    signed.signature,
    signed.publicKey,
    stamp.path,
    now,
  );

  db.prepare(`UPDATE defense_requests SET status = 'defended' WHERE id = ?`).run(
    request.id,
  );

  return {
    receipt: signed,
    grades,
    score: aggregateScore(grades),
    flagged: shouldFlagForHuman(grades) || integrity.status !== "Clear",
    stampPath: `/api/stamp/${signed.payload.id}`,
  };
}

export function getReceipt(receiptId: string): SignedReceipt | null {
  const row = getDb()
    .prepare(`SELECT payload_json FROM receipts WHERE id = ?`)
    .get(receiptId) as { payload_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.payload_json) as SignedReceipt;
}

export function listReceiverDashboard(email: string) {
  return getDb()
    .prepare(
      `SELECT r.id, r.token, r.title, r.difficulty, r.status, r.created_at,
              rc.id as receipt_id, rc.payload_json
       FROM defense_requests r
       JOIN receivers rv ON rv.id = r.receiver_id
       LEFT JOIN receipts rc ON rc.request_id = r.id
       WHERE lower(rv.email) = lower(?)
       ORDER BY r.created_at DESC`,
    )
    .all(email) as {
    id: string;
    token: string;
    title: string;
    difficulty: string;
    status: string;
    created_at: string;
    receipt_id: string | null;
    payload_json: string | null;
  }[];
}

export function listAdminSessions() {
  return getDb()
    .prepare(
      `SELECT s.id, s.mode, s.creator_name, s.creator_email, s.status, s.completed_at,
              r.title, r.difficulty, r.token,
              rc.id as receipt_id,
              hg.overall_score as human_score
       FROM sessions s
       JOIN defense_requests r ON r.id = s.request_id
       LEFT JOIN receipts rc ON rc.session_id = s.id
       LEFT JOIN human_grades hg ON hg.session_id = s.id
       WHERE s.mode = 'defend'
       ORDER BY s.started_at DESC`,
    )
    .all() as {
    id: string;
    mode: string;
    creator_name: string;
    creator_email: string;
    status: string;
    completed_at: string | null;
    title: string;
    difficulty: string;
    token: string;
    receipt_id: string | null;
    human_score: number | null;
  }[];
}

export function getAdminSessionDetail(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) return null;
  const grades = getDb()
    .prepare(`SELECT * FROM grades WHERE session_id = ?`)
    .all(sessionId) as {
    model_id: string;
    provider: string;
    scores_json: string;
    overall_score: number;
  }[];
  const human = getDb()
    .prepare(`SELECT * FROM human_grades WHERE session_id = ?`)
    .get(sessionId) as
    | {
        overall_score: number;
        notes: string | null;
        grader_name: string;
      }
    | undefined;
  const receipt = getDb()
    .prepare(`SELECT id, payload_json FROM receipts WHERE session_id = ?`)
    .get(sessionId) as { id: string; payload_json: string } | undefined;

  return {
    session,
    grades: grades.map((g) => JSON.parse(g.scores_json) as ModelGrade),
    human,
    receipt: receipt
      ? (JSON.parse(receipt.payload_json) as SignedReceipt)
      : null,
  };
}

export function saveHumanGrade(opts: {
  sessionId: string;
  overallScore: number;
  notes?: string;
  graderName: string;
}) {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM human_grades WHERE session_id = ?`)
    .get(opts.sessionId) as { id: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE human_grades SET overall_score = ?, notes = ?, grader_name = ?, created_at = ? WHERE id = ?`,
    ).run(
      opts.overallScore,
      opts.notes || null,
      opts.graderName,
      now,
      existing.id,
    );
    return existing.id;
  }
  const id = newId("hum");
  db.prepare(
    `INSERT INTO human_grades (id, session_id, overall_score, notes, grader_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.sessionId,
    opts.overallScore,
    opts.notes || null,
    opts.graderName,
    now,
  );
  return id;
}

export function publicKeyInfo() {
  return {
    publicKeyHex: getPublicKeyHex(),
    algorithm: "Ed25519",
    llmMode: llmModeLabel(),
  };
}
