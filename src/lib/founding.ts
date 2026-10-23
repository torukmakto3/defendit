/**
 * Founding member: €149 once, lifetime Pro, 100 spots.
 *
 * A spot is reserved when Checkout is created and confirmed when the payment
 * webhook arrives. The inventory row is locked for the count, on Postgres and
 * on SQLite (`BEGIN IMMEDIATE`). A lifetime plan is stored with
 * `stripe_subscription_id = founding_<user id>` so a later subscription event
 * for a different id does not replace it.
 */

import { grantSubscriptionMonth, type CreditSource, type LedgerKind } from "./credits";
import { getDb, type Db } from "./db";
import { HttpError } from "./errors";
import { newId } from "./ids";
import { FOUNDING_CAP } from "./plans";
import { addUtcMonths } from "./subscription-refill";

export const FOUNDING_HOLD_MS = 35 * 60 * 1000;
const INVENTORY_ID = "founding";
const SPOTS_CACHE_MS = 15_000;

export type FoundingOutcome = "granted" | "replay" | "sold_out" | "held_elsewhere" | "already_member";

export interface FoundingGrant {
  kind: LedgerKind;
  source: CreditSource;
  credits: number;
}

export interface FoundingAvailability {
  cap: number;
  held: number;
  remaining: number;
}

let spotsCache: { at: number; value: FoundingAvailability } | null = null;

export function clearFoundingSpotsCacheForTests(): void {
  spotsCache = null;
}

/** Stable id stored on the plan. User ids have no colon, so refill keys stay parseable. */
export function foundingSubscriptionId(userId: string): string {
  return `founding_${userId}`;
}

export async function reserveFoundingSpot(
  userId: string,
  now = new Date(),
): Promise<{ spotId: string; expiresAt: Date }> {
  const db = await getDb();
  const reserved = await db.transaction(async (tx) => {
    await lockInventory(tx);
    await sweepReserved(tx, now.toISOString());
    const open = await openSpot(tx, userId);
    if (open?.status === "confirmed") {
      throw new HttpError(409, "You already have a founding membership.");
    }
    const expiresAt = new Date(now.getTime() + FOUNDING_HOLD_MS);
    if (open?.status === "reserved") {
      await tx.run(`UPDATE founding_spots SET expires_at = ? WHERE id = ?`, [expiresAt.toISOString(), open.id]);
      return { spotId: open.id, expiresAt };
    }
    const held = await heldCount(tx, now.toISOString());
    if (held >= FOUNDING_CAP) throw new HttpError(409, "Founding membership is sold out.");
    const spotId = newId("fspot");
    try {
      await tx.run(
        `INSERT INTO founding_spots
          (id, user_id, status, checkout_session_id, payment_intent_id, reserved_at, expires_at, confirmed_at, released_at)
         VALUES (?, ?, 'reserved', NULL, NULL, ?, ?, NULL, NULL)`,
        [spotId, userId, now.toISOString(), expiresAt.toISOString()],
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "Founding membership is sold out.");
      throw e;
    }
    return { spotId, expiresAt };
  });
  spotsCache = null;
  return reserved;
}

export async function attachFoundingCheckout(spotId: string, sessionId: string): Promise<void> {
  const db = await getDb();
  const updated = await db.run(
    `UPDATE founding_spots SET checkout_session_id = ? WHERE id = ? AND status = 'reserved'`,
    [sessionId, spotId],
  );
  if (updated.changes !== 1) throw new HttpError(409, "That founding hold is no longer open.");
  spotsCache = null;
}

/** Drop a hold when Checkout could not be created. A confirmed spot stays. */
export async function releaseFoundingReservation(spotId: string, now = new Date()): Promise<void> {
  const db = await getDb();
  await db.run(
    `UPDATE founding_spots SET status = 'released', released_at = ? WHERE id = ? AND status = 'reserved'`,
    [now.toISOString(), spotId],
  );
  spotsCache = null;
}

/** `checkout.session.expired`. Only a still-reserved row for that session is released. */
export async function releaseFoundingBySession(sessionId: string, now = new Date()): Promise<void> {
  const db = await getDb();
  await db.run(
    `UPDATE founding_spots SET status = 'released', released_at = ?
     WHERE checkout_session_id = ? AND status = 'reserved'`,
    [now.toISOString(), sessionId],
  );
  spotsCache = null;
}

export async function sweepExpiredFoundingHolds(now = new Date()): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await lockInventory(tx);
    await sweepReserved(tx, now.toISOString());
  });
  spotsCache = null;
}

/**
 * Confirm a paid Checkout session. A reserved row is confirmed even after
 * `expires_at` if it has not been released. A missing row (crash before the
 * session id was stored) claims a fresh spot only when this account has no
 * open spot and the cap still has room.
 */
export async function confirmFoundingPayment(input: {
  userId: string;
  sessionId: string;
  paymentIntentId: string | null;
  now?: Date;
}): Promise<{ outcome: FoundingOutcome; grants: FoundingGrant[] }> {
  const now = input.now ?? new Date();
  const db = await getDb();
  const outcome = await db.transaction(async (tx) => {
    await lockInventory(tx);
    await sweepReserved(tx, now.toISOString(), input.sessionId);
    const bySession = await tx.get<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, status FROM founding_spots WHERE checkout_session_id = ?`,
      [input.sessionId],
    );
    if (bySession && bySession.user_id === input.userId && bySession.status === "confirmed") return "replay" as const;
    if (bySession && bySession.user_id === input.userId && bySession.status === "reserved") {
      await markConfirmed(tx, bySession.id, input.paymentIntentId, now);
      return "granted" as const;
    }
    const open = await openSpot(tx, input.userId);
    if (open?.status === "confirmed") return "already_member" as const;
    if (open?.status === "reserved") return "held_elsewhere" as const;
    const held = await heldCount(tx, now.toISOString());
    if (held >= FOUNDING_CAP) return "sold_out" as const;
    const spotId = newId("fspot");
    try {
      await insertConfirmedSpot(tx, {
        spotId,
        userId: input.userId,
        sessionId: input.sessionId,
        paymentIntentId: input.paymentIntentId,
        now,
      });
    } catch (e) {
      if (isUniqueViolation(e)) return "sold_out" as const;
      throw e;
    }
    return "granted" as const;
  });
  spotsCache = null;
  if (outcome !== "granted" && outcome !== "replay") return { outcome, grants: [] };
  const granted = await grantSubscriptionMonth({
    userId: input.userId,
    planId: "subscription",
    subscriptionId: foundingSubscriptionId(input.userId),
    periodIndex: 0,
    periodStart: now.toISOString(),
    periodEnd: addUtcMonths(now, 1).toISOString(),
    grantAnchor: now.toISOString(),
    activate: true,
    interval: "lifetime",
  });
  return { outcome, grants: granted.grants };
}

/**
 * A founding refund or dispute ends the lifetime plan and frees the spot.
 * Credits are left to the proportional claw that already ran. This does not
 * expire the rest of the subscription bucket.
 */
export async function endFoundingMemberships(
  tx: Db,
  grants: { user_id: string; sku: string }[],
): Promise<void> {
  const users = new Set(grants.filter((grant) => grant.sku === "founding_lifetime").map((grant) => grant.user_id));
  const now = new Date().toISOString();
  for (const userId of users) {
    const subscriptionId = foundingSubscriptionId(userId);
    await tx.run(
      `INSERT INTO stripe_subscription_state (subscription_id, last_event_created, terminal, refills_stopped)
       VALUES (?, 0, 0, 1)
       ON CONFLICT (subscription_id) DO UPDATE SET refills_stopped = 1`,
      [subscriptionId],
    );
    await tx.run(
      `UPDATE user_plans SET
         plan_id = 'payg',
         interval = NULL,
         status = 'canceled',
         period_id = ?,
         current_period_end = NULL,
         stripe_subscription_id = NULL,
         cancel_at_period_end = 0,
         updated_at = ?
       WHERE user_id = ? AND interval = 'lifetime'`,
      [`end:${subscriptionId}`, now, userId],
    );
    await tx.run(
      `UPDATE founding_spots SET status = 'released', released_at = ?
       WHERE user_id = ? AND status IN ('reserved', 'confirmed')`,
      [now, userId],
    );
  }
  if (users.size > 0) spotsCache = null;
}

/** Confirmed spots plus reserved spots that have not expired. Cached for a few seconds. */
export async function publicFoundingAvailability(now = new Date()): Promise<FoundingAvailability> {
  if (spotsCache && Date.now() - spotsCache.at < SPOTS_CACHE_MS) return spotsCache.value;
  await sweepExpiredFoundingHolds(now);
  const db = await getDb();
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COUNT(*) AS n FROM founding_spots
     WHERE status = 'confirmed' OR (status = 'reserved' AND expires_at > ?)`,
    [now.toISOString()],
  );
  const held = Number(row?.n ?? 0);
  const value = { cap: FOUNDING_CAP, held, remaining: Math.max(0, FOUNDING_CAP - held) };
  spotsCache = { at: Date.now(), value };
  return value;
}

export function normalizeWaitlistEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Deduped. A repeat address is success and does not reveal whether it was new. */
export async function joinFoundingWaitlist(email: string): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO founding_waitlist (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING`,
    [email, new Date().toISOString()],
  );
}

async function lockInventory(tx: Db): Promise<void> {
  await tx.run(
    `INSERT INTO founding_inventory (id, lock_nonce) VALUES (?, 0) ON CONFLICT (id) DO NOTHING`,
    [INVENTORY_ID],
  );
  const locked = await tx.run(`UPDATE founding_inventory SET lock_nonce = lock_nonce + 1 WHERE id = ?`, [
    INVENTORY_ID,
  ]);
  if (locked.changes !== 1) throw new HttpError(500, "Could not lock founding inventory.");
}

async function sweepReserved(tx: Db, nowIso: string, keepSessionId?: string): Promise<void> {
  if (keepSessionId) {
    await tx.run(
      `UPDATE founding_spots SET status = 'released', released_at = ?
       WHERE status = 'reserved' AND expires_at <= ?
         AND (checkout_session_id IS NULL OR checkout_session_id <> ?)`,
      [nowIso, nowIso, keepSessionId],
    );
    return;
  }
  await tx.run(
    `UPDATE founding_spots SET status = 'released', released_at = ?
     WHERE status = 'reserved' AND expires_at <= ?`,
    [nowIso, nowIso],
  );
}

async function heldCount(tx: Db, nowIso: string): Promise<number> {
  const row = await tx.get<{ n: number | string | null }>(
    `SELECT COUNT(*) AS n FROM founding_spots
     WHERE status = 'confirmed' OR (status = 'reserved' AND expires_at > ?)`,
    [nowIso],
  );
  return Number(row?.n ?? 0);
}

async function openSpot(tx: Db, userId: string): Promise<{ id: string; status: string } | undefined> {
  return tx.get<{ id: string; status: string }>(
    `SELECT id, status FROM founding_spots WHERE user_id = ? AND status IN ('reserved', 'confirmed')`,
    [userId],
  );
}

async function markConfirmed(tx: Db, spotId: string, paymentIntentId: string | null, now: Date): Promise<void> {
  const confirmedAt = now.toISOString();
  if (paymentIntentId) {
    await tx.run(
      `UPDATE founding_spots SET status = 'confirmed', payment_intent_id = ?, confirmed_at = ?, expires_at = NULL
       WHERE id = ? AND status = 'reserved'`,
      [paymentIntentId, confirmedAt, spotId],
    );
    return;
  }
  await tx.run(
    `UPDATE founding_spots SET status = 'confirmed', confirmed_at = ?, expires_at = NULL
     WHERE id = ? AND status = 'reserved'`,
    [confirmedAt, spotId],
  );
}

async function insertConfirmedSpot(
  tx: Db,
  input: { spotId: string; userId: string; sessionId: string; paymentIntentId: string | null; now: Date },
): Promise<void> {
  const nowIso = input.now.toISOString();
  if (input.paymentIntentId) {
    await tx.run(
      `INSERT INTO founding_spots
        (id, user_id, status, checkout_session_id, payment_intent_id, reserved_at, expires_at, confirmed_at, released_at)
       VALUES (?, ?, 'confirmed', ?, ?, ?, NULL, ?, NULL)`,
      [input.spotId, input.userId, input.sessionId, input.paymentIntentId, nowIso, nowIso],
    );
    return;
  }
  await tx.run(
    `INSERT INTO founding_spots
      (id, user_id, status, checkout_session_id, payment_intent_id, reserved_at, expires_at, confirmed_at, released_at)
     VALUES (?, ?, 'confirmed', ?, NULL, ?, NULL, ?, NULL)`,
    [input.spotId, input.userId, input.sessionId, nowIso, nowIso],
  );
}

function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = "code" in e ? String(e.code) : "";
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505") return true;
  const message = e instanceof Error ? e.message : "";
  return /UNIQUE constraint failed|duplicate key value/i.test(message);
}
