/**
 * Removes one account and the rows that reference it.
 *
 * A founding spot is released, the same way a refund releases it, so the cap
 * slot opens. The row stays for accounting (checkout session, payment intent,
 * timestamps) on a retained anchor, because user_id is required. A released
 * row is not counted. The person's email is not copied onto that anchor.
 */

import { getDb, type Db } from "./db";
import { foundingSubscriptionId } from "./founding";
import { newId } from "./ids";

/** Sample charges stay on this account after the visitor row is deleted. */
export const LEDGER_ANCHOR_EMAIL = "ledger@demo.defendit.invalid";

/** Released founding spots of deleted accounts. Not a person, and not counted. */
export const FOUNDING_RELEASED_ANCHOR_EMAIL = "founding-released@defendit.invalid";

export function isRetainedAccountEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized === LEDGER_ANCHOR_EMAIL || normalized === FOUNDING_RELEASED_ANCHOR_EMAIL;
}

/** Deletes the account. Returns false when the id is missing or is a retained anchor. */
export async function deleteAccountData(userId: string): Promise<boolean> {
  const db = await getDb();
  const user = await db.get<{ email: string }>(`SELECT email FROM users WHERE id = ?`, [userId]);
  if (!user || isRetainedAccountEmail(user.email)) return false;
  await db.transaction(async (tx) => {
    await deleteAccountRows(tx, userId, user.email);
  });
  return true;
}

/**
 * FK-safe account removal. Caller holds the transaction. Demo purge uses this
 * after the expired sample's sessions and receipts are already gone.
 */
export async function deleteAccountRows(tx: Db, userId: string, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (isRetainedAccountEmail(normalized)) return;
  const now = new Date().toISOString();
  const ledgerAnchor = await retainedUserId(tx, LEDGER_ANCHOR_EMAIL, now);
  const foundingAnchor = await retainedUserId(tx, FOUNDING_RELEASED_ANCHOR_EMAIL, now);

  await tx.run(
    `DELETE FROM defense_feedback
     WHERE user_id = ?
        OR session_id IN (
          SELECT id FROM sessions
          WHERE user_id = ? OR request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)
        )
        OR receipt_id IN (
          SELECT id FROM receipts
          WHERE request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)
        )`,
    [userId, userId, userId, userId],
  );
  await tx.run(`DELETE FROM beta_allowance_topups WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM founding_waitlist WHERE lower(email) = ?`, [normalized]);
  await tx.run(`DELETE FROM login_tokens WHERE lower(email) = ?`, [normalized]);

  const foundingSpot = await tx.get<{ id: string }>(`SELECT id FROM founding_spots WHERE user_id = ?`, [userId]);
  const lifetime = await tx.get<{ user_id: string }>(
    `SELECT user_id FROM user_plans WHERE user_id = ? AND interval = 'lifetime'`,
    [userId],
  );
  if (foundingSpot || lifetime) {
    await tx.run(
      `INSERT INTO stripe_subscription_state (subscription_id, last_event_created, terminal, refills_stopped)
       VALUES (?, 0, 1, 1)
       ON CONFLICT (subscription_id) DO UPDATE SET terminal = 1, refills_stopped = 1`,
      [foundingSubscriptionId(userId)],
    );
  }
  await tx.run(
    `UPDATE founding_spots
     SET user_id = ?, status = 'released', released_at = COALESCE(released_at, ?)
     WHERE user_id = ?`,
    [foundingAnchor, now, userId],
  );

  await tx.run(
    `DELETE FROM challenge_events WHERE challenge_id IN (SELECT id FROM challenges WHERE creator_user_id = ?)`,
    [userId],
  );
  await tx.run(
    `DELETE FROM challenge_hides
     WHERE user_id = ? OR challenge_id IN (SELECT id FROM challenges WHERE creator_user_id = ?)`,
    [userId, userId],
  );
  await tx.run(
    `DELETE FROM credit_challenge_claims
     WHERE challenger_user_id = ? OR defender_user_id = ?
        OR challenge_id IN (SELECT id FROM challenges WHERE creator_user_id = ?)`,
    [userId, userId, userId],
  );
  await tx.run(`DELETE FROM challenges WHERE creator_user_id = ?`, [userId]);
  await tx.run(`UPDATE challenges SET claimed_by_user_id = NULL WHERE claimed_by_user_id = ?`, [userId]);
  await tx.run(`DELETE FROM challenge_opt_outs WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM challenge_opt_out_keys WHERE user_id = ?`, [userId]);
  await tx.run(
    `UPDATE challenges
     SET request_id = NULL, deliverable_id = NULL, session_id = NULL, receipt_id = NULL
     WHERE request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)
        OR session_id IN (SELECT id FROM sessions WHERE user_id = ?)`,
    [userId, userId],
  );

  const ownedSessions = `SELECT id FROM sessions
    WHERE user_id = ? OR request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)`;
  await tx.run(`DELETE FROM budget_holds WHERE session_id IN (${ownedSessions})`, [userId, userId]);
  await tx.run(
    `DELETE FROM defense_holds WHERE user_id = ? OR session_id IN (${ownedSessions})`,
    [userId, userId, userId],
  );
  await tx.run(`DELETE FROM grades WHERE session_id IN (${ownedSessions})`, [userId, userId]);
  await tx.run(`DELETE FROM human_grades WHERE session_id IN (${ownedSessions})`, [userId, userId]);
  await tx.run(
    `DELETE FROM receipts
     WHERE session_id IN (${ownedSessions})
        OR request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)`,
    [userId, userId, userId],
  );
  await tx.run(
    `DELETE FROM flashcards
     WHERE user_id = ? OR request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)`,
    [userId, userId],
  );
  await tx.run(
    `DELETE FROM llm_calls
     WHERE request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)
        OR session_id IN (SELECT id FROM sessions WHERE user_id = ?)`,
    [userId, userId],
  );
  await tx.run(
    `DELETE FROM stage_timings
     WHERE request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)
        OR session_id IN (SELECT id FROM sessions WHERE user_id = ?)`,
    [userId, userId],
  );
  await tx.run(
    `DELETE FROM demo_passes
     WHERE user_id = ? OR request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)`,
    [userId, userId],
  );
  await tx.run(
    `DELETE FROM sessions
     WHERE user_id = ? OR request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)`,
    [userId, userId],
  );
  await tx.run(
    `DELETE FROM deliverables
     WHERE owner_user_id = ? OR request_id IN (SELECT id FROM defense_requests WHERE owner_user_id = ?)`,
    [userId, userId],
  );
  await tx.run(`DELETE FROM defense_requests WHERE owner_user_id = ?`, [userId]);
  await tx.run(`UPDATE defense_requests SET creator_user_id = NULL WHERE creator_user_id = ?`, [userId]);

  await tx.run(`UPDATE credit_ledger SET user_id = ? WHERE user_id = ?`, [ledgerAnchor, userId]);
  await tx.run(`DELETE FROM credit_wallets WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM beta_grants WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM auth_sessions WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM user_plans WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM billing_profiles WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM stripe_grants WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM billing_overages WHERE user_id = ?`, [userId]);
  await tx.run(`DELETE FROM users WHERE id = ?`, [userId]);
}

/** Deletes a rating when the purge removes its session or receipt. */
export async function deleteFeedbackForPurgedReceipts(tx: Db, nowIso: string): Promise<void> {
  await tx.run(
    `DELETE FROM defense_feedback
     WHERE receipt_id IN (SELECT id FROM receipts WHERE purge_after IS NOT NULL AND purge_after < ?)
        OR session_id IN (SELECT session_id FROM receipts WHERE purge_after IS NOT NULL AND purge_after < ?)`,
    [nowIso, nowIso],
  );
}

export async function deleteFeedbackForRequest(tx: Db, requestId: string): Promise<void> {
  await tx.run(
    `DELETE FROM defense_feedback
     WHERE session_id IN (SELECT id FROM sessions WHERE request_id = ?)
        OR receipt_id IN (SELECT id FROM receipts WHERE request_id = ?)`,
    [requestId, requestId],
  );
}

async function retainedUserId(tx: Db, email: string, nowIso: string): Promise<string> {
  const existing = await tx.get<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [email]);
  if (existing) return existing.id;
  const id = newId("usr");
  await tx.run(
    `INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, NULL, ?)
     ON CONFLICT (email) DO NOTHING`,
    [id, email, nowIso],
  );
  const row = await tx.get<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [email]);
  if (!row) throw new Error("retained account missing");
  return row.id;
}
