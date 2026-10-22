import { getDb } from "./db";
import { HttpError } from "./errors";
import { newId } from "./ids";

/** Stages the admin session page shows, in interview order. */
export const STAGE_ORDER = [
  "upload_parse",
  "first_question",
  "tts_first_audio",
  "grader",
  "aggregation",
  "receipt_sign",
] as const;

export interface StageTiming {
  stage: string;
  detail: string | null;
  durationMs: number;
  createdAt: string;
}

/**
 * Persist one stage and log it. A timing failure must not fail the defense.
 * The log line is counts and ids only: never question text or document text.
 */
export async function recordStageTiming(input: {
  requestId?: string | null;
  sessionId?: string | null;
  stage: string;
  detail?: string | null;
  durationMs: number;
}): Promise<void> {
  const durationMs = Math.max(0, Math.round(input.durationMs));
  const detail = input.detail?.slice(0, 160) || null;
  const stage = input.stage.slice(0, 40);
  console.info(
    JSON.stringify({
      msg: "stage_timing",
      requestId: input.requestId ?? null,
      sessionId: input.sessionId ?? null,
      stage,
      detail,
      durationMs,
    }),
  );
  try {
    const db = await getDb();
    await db.run(
      `INSERT INTO stage_timings (id, request_id, session_id, stage, detail, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("tim"),
        input.requestId ?? null,
        input.sessionId ?? null,
        stage,
        detail,
        durationMs,
        new Date().toISOString(),
      ],
    );
  } catch (e) {
    console.error("[timing] failed to record stage", e instanceof Error ? e.message : e);
  }
}

/** Upload rows (no session yet) plus everything recorded against the session. */
export async function listStageTimings(ids: {
  requestId?: string | null;
  sessionId?: string | null;
}): Promise<StageTiming[]> {
  const db = await getDb();
  const rows = await db.all<{
    stage: string;
    detail: string | null;
    duration_ms: number;
    created_at: string;
  }>(
    `SELECT stage, detail, duration_ms, created_at FROM stage_timings
     WHERE session_id = ? OR (request_id = ? AND session_id IS NULL)
     ORDER BY created_at, id`,
    [ids.sessionId ?? "", ids.requestId ?? ""],
  );
  return rows.map((row) => ({
    stage: row.stage,
    detail: row.detail,
    durationMs: Number(row.duration_ms),
    createdAt: row.created_at,
  }));
}

/** The voice agent reports when the creator first hears the examiner. */
export async function recordVoiceFirstAudio(sessionId: string, durationMs: number): Promise<void> {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 120_000) {
    throw new HttpError(400, "Bad timing");
  }
  const db = await getDb();
  const session = await db.get<{ id: string; request_id: string }>(
    `SELECT id, request_id FROM sessions WHERE id = ? AND mode = 'defend'`,
    [sessionId],
  );
  if (!session) throw new HttpError(404, "Voice session not found");
  await recordStageTiming({
    requestId: session.request_id,
    sessionId: session.id,
    stage: "tts_first_audio",
    detail: "livekit",
    durationMs,
  });
}
