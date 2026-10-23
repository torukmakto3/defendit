import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeMagicLink, requestMagicLink } from "../src/lib/auth";
import { getBalance, getUserPlan, renewPlan } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import {
  attachFoundingCheckout,
  clearFoundingSpotsCacheForTests,
  confirmFoundingPayment,
  FOUNDING_HOLD_MS,
  foundingSubscriptionId,
  publicFoundingAvailability,
  releaseFoundingBySession,
  reserveFoundingSpot,
} from "../src/lib/founding";
import { applyBillingEvent } from "../src/lib/payments";
import { FOUNDING_CAP } from "../src/lib/plans";
import { addUtcMonths, grantDueSubscriptionRefills } from "../src/lib/subscription-refill";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-founding-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  delete process.env.DATABASE_URL;
  delete process.env.BILLING_ENABLED;
});

beforeEach(async () => {
  const db = await getDb();
  await db.run(`DELETE FROM founding_spots`);
  clearFoundingSpotsCacheForTests();
});

async function createUser(label: string): Promise<string> {
  const db = await getDb();
  const id = `usr_${label}`;
  await db.run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, NULL, ?)`, [
    id,
    `${label}@founding.test`,
    new Date().toISOString(),
  ]);
  return id;
}

describe("founding spots", () => {
  it("stops at 100 reserved spots and lets an expired hold go back on sale", async () => {
    const now = new Date("2026-10-23T12:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < FOUNDING_CAP; i += 1) {
      const userId = await createUser(`cap${i}`);
      ids.push(userId);
      await reserveFoundingSpot(userId, now);
    }
    await expect(reserveFoundingSpot(await createUser("cap-extra"), now)).rejects.toMatchObject({ status: 409 });
    const db = await getDb();
    await db.run(`UPDATE founding_spots SET expires_at = ? WHERE user_id = ?`, [
      new Date(now.getTime() - 1000).toISOString(),
      ids[0],
    ]);
    const again = await reserveFoundingSpot(await createUser("cap-after-expiry"), now);
    expect(again.spotId).toEqual(expect.any(String));
    expect(again.expiresAt.getTime() - now.getTime()).toBe(FOUNDING_HOLD_MS);
    const spots = await publicFoundingAvailability(now);
    expect(spots).toMatchObject({ cap: 100, held: 100, remaining: 0 });
  });

  it("keeps one open spot per account and releases it when checkout expires", async () => {
    const userId = await createUser("one-spot");
    const first = await reserveFoundingSpot(userId);
    const second = await reserveFoundingSpot(userId);
    expect(second.spotId).toBe(first.spotId);
    await attachFoundingCheckout(first.spotId, "cs_one_spot");
    await releaseFoundingBySession("cs_one_spot");
    const db = await getDb();
    const row = await db.get<{ status: string }>(`SELECT status FROM founding_spots WHERE id = ?`, [first.spotId]);
    expect(row?.status).toBe("released");
    const third = await reserveFoundingSpot(userId);
    expect(third.spotId).not.toBe(first.spotId);
  });

  it("grants lifetime Pro, ignores a later subscription, and refills the next month", async () => {
    const userId = await createUser("life");
    const anchor = new Date("2026-01-15T00:00:00.000Z");
    const hold = await reserveFoundingSpot(userId, anchor);
    await attachFoundingCheckout(hold.spotId, "cs_life");
    const confirmed = await confirmFoundingPayment({
      userId,
      sessionId: "cs_life",
      paymentIntentId: "pi_life",
      now: anchor,
    });
    expect(confirmed.outcome).toBe("granted");
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    const plan = await getUserPlan(userId);
    expect(plan.interval).toBe("lifetime");
    expect(plan.plan.id).toBe("subscription");

    await renewPlan({
      userId,
      planId: "subscription",
      interval: "month",
      periodId: "in_other",
      subscriptionId: "sub_other",
    });
    expect((await getUserPlan(userId)).interval).toBe("lifetime");
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5 });

    const later = addUtcMonths(anchor, 1);
    const refilled = await grantDueSubscriptionRefills({ userId, now: later });
    expect(refilled.granted).toBe(1);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    expect((await getUserPlan(userId)).interval).toBe("lifetime");
  });

  it("ends the lifetime plan on a partial refund and frees the spot", async () => {
    const { devLink } = await requestMagicLink({ email: "refund-founding@fund.example" });
    const token = devLink!.split("#token=")[1];
    const signed = await consumeMagicLink(token);
    const userId = signed!.user.id;
    const anchor = new Date("2026-03-01T00:00:00.000Z");
    const hold = await reserveFoundingSpot(userId, anchor);
    await attachFoundingCheckout(hold.spotId, "cs_refund_founding");
    await applyBillingEvent({
      id: "evt_founding_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_refund_founding",
          client_reference_id: userId,
          payment_status: "paid",
          mode: "payment",
          payment_intent: "pi_refund_founding",
          metadata: { user_id: userId, sku: "founding_lifetime", lookup_key: "founding_lifetime" },
          line_items: { data: [{ price: { id: "price_founding", lookup_key: "founding_lifetime" } }] },
        },
      },
    });
    expect((await getUserPlan(userId)).interval).toBe("lifetime");
    expect((await getBalance(userId)).defense).toBe(10);
    const refunded = await applyBillingEvent({
      id: "evt_founding_refund",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_founding",
          payment_intent: "pi_refund_founding",
          amount: 14900,
          amount_refunded: 7450,
        },
      },
    });
    expect(refunded.duplicate).toBe(false);
    expect((await getUserPlan(userId)).plan.id).toBe("payg");
    expect((await getBalance(userId)).defense).toBe(5);
    const db = await getDb();
    const spot = await db.get<{ status: string }>(
      `SELECT status FROM founding_spots WHERE user_id = ? AND status IN ('reserved', 'confirmed')`,
      [userId],
    );
    expect(spot).toBeUndefined();
    const stopped = await db.get<{ refills_stopped: number | string }>(
      `SELECT refills_stopped FROM stripe_subscription_state WHERE subscription_id = ?`,
      [foundingSubscriptionId(userId)],
    );
    expect(Number(stopped?.refills_stopped)).toBe(1);
  });
});
