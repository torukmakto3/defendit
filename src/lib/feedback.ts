/**
 * One rating per signed-in defender, for a defense they completed.
 * The comment stays off public receipt JSON. Aggregates go through `/api/stats`.
 */

import { getDb } from "./db";
import { HttpError } from "./errors";
import { newId } from "./ids";

export const FEEDBACK_COMMENT_MAX = 1000;

export interface DefenseFeedbackView {
  canSubmit: boolean;
  rating: number | null;
  comment: string | null;
}

interface OwnedDefense {
  session_id: string;
  user_id: string;
  status: string;
  mode: string;
}

export async function feedbackForReceipt(receiptId: string, userId: string | null): Promise<DefenseFeedbackView> {
  if (!userId) return { canSubmit: false, rating: null, comment: null };
  const owned = await ownedDefense(receiptId);
  if (!owned || owned.user_id !== userId || !isCompletedDefense(owned)) {
    return { canSubmit: false, rating: null, comment: null };
  }
  const db = await getDb();
  const row = await db.get<{ rating: number | string; comment: string }>(
    `SELECT rating, comment FROM defense_feedback WHERE user_id = ? AND session_id = ?`,
    [userId, owned.session_id],
  );
  if (!row) return { canSubmit: true, rating: null, comment: null };
  return { canSubmit: true, rating: Number(row.rating), comment: row.comment };
}

export async function saveDefenseFeedback(input: {
  receiptId: string;
  userId: string;
  rating: number;
  comment?: string | null;
}): Promise<void> {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new HttpError(400, "Rating must be from 1 to 5.");
  }
  const comment = (input.comment ?? "").trim();
  if (comment.length > FEEDBACK_COMMENT_MAX) {
    throw new HttpError(400, `Comment must be ${FEEDBACK_COMMENT_MAX} characters or fewer.`);
  }
  const owned = await ownedDefense(input.receiptId);
  if (!owned || owned.user_id !== input.userId || !isCompletedDefense(owned)) {
    throw new HttpError(403, "You can rate a defense you completed.");
  }
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO defense_feedback
      (id, user_id, session_id, receipt_id, rating, comment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, session_id) DO UPDATE SET
       rating = excluded.rating,
       comment = excluded.comment,
       receipt_id = excluded.receipt_id,
       updated_at = excluded.updated_at`,
    [newId("fb"), input.userId, owned.session_id, input.receiptId, input.rating, comment, now, now],
  );
}

async function ownedDefense(receiptId: string): Promise<OwnedDefense | undefined> {
  const db = await getDb();
  return db.get<OwnedDefense>(
    `SELECT s.id AS session_id, s.user_id, s.status, s.mode
     FROM receipts rc
     JOIN sessions s ON s.id = rc.session_id
     WHERE rc.id = ?`,
    [receiptId],
  );
}

function isCompletedDefense(row: OwnedDefense): boolean {
  return row.mode === "defend" && row.status === "completed";
}
