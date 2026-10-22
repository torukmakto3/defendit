import type { Db } from "./db";
import { HttpError } from "./errors";
import { newId } from "./ids";

/**
 * Paid-challenge credits. This module never imports a payment SDK and never
 * contacts Stripe. A hold is a row in `challenge_credits`. Refunds are rows
 * too. Sharing and posting do not create, hold, or release a credit.
 *
 * `BILLING_ENABLED` defaults off. While it is off, a paid challenge cannot
 * be created, so nothing is held and nothing is spent.
 */

export type CreditAction = "hold" | "consume" | "refund";
export type RefundReason = "decline" | "expiry" | "revoke";

export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "1";
}

/** Refuse a paid challenge when billing is off. No credit row is written. */
export function assertPaidChallengesOpen(): void {
  if (!billingEnabled()) {
    throw new HttpError(402, "Paid challenges are turned off.");
  }
}

async function actions(db: Db, challengeId: string): Promise<CreditAction[]> {
  const rows = await db.all<{ action: string }>(
    `SELECT action FROM challenge_credits WHERE challenge_id = ?`,
    [challengeId],
  );
  return rows.map((row) => row.action as CreditAction);
}

export async function holdPaidCredit(db: Db, challengeId: string): Promise<void> {
  const existing = await actions(db, challengeId);
  if (existing.includes("hold")) return;
  await db.run(
    `INSERT INTO challenge_credits (id, challenge_id, action, reason, created_at) VALUES (?, ?, 'hold', NULL, ?)`,
    [newId("crd"), challengeId, new Date().toISOString()],
  );
}

/**
 * Mark the held credit used. A beta challenge has no hold, so this is a no-op.
 * A refunded or already-consumed credit is left alone.
 */
export async function consumePaidCredit(db: Db, challengeId: string): Promise<void> {
  const existing = await actions(db, challengeId);
  if (!existing.includes("hold")) return;
  if (existing.includes("consume") || existing.includes("refund")) return;
  await db.run(
    `INSERT INTO challenge_credits (id, challenge_id, action, reason, created_at) VALUES (?, ?, 'consume', NULL, ?)`,
    [newId("crd"), challengeId, new Date().toISOString()],
  );
}

/**
 * Return a held credit on decline (the defender kept the result private),
 * expiry, or revoke. No hold means there is nothing to return.
 */
export async function refundPaidCredit(db: Db, challengeId: string, reason: RefundReason): Promise<void> {
  const existing = await actions(db, challengeId);
  if (!existing.includes("hold")) return;
  if (existing.includes("refund") || existing.includes("consume")) return;
  await db.run(
    `INSERT INTO challenge_credits (id, challenge_id, action, reason, created_at) VALUES (?, ?, 'refund', ?, ?)`,
    [newId("crd"), challengeId, reason, new Date().toISOString()],
  );
}

export async function creditLedger(
  db: Db,
  challengeId: string,
): Promise<{ action: string; reason: string | null }[]> {
  return db.all(
    `SELECT action, reason FROM challenge_credits WHERE challenge_id = ? ORDER BY created_at`,
    [challengeId],
  );
}
