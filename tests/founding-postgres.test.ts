import { randomBytes } from "crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getBalance, getUserPlan } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import {
  confirmFoundingPayment,
  foundingSubscriptionId,
  reserveFoundingSpot,
} from "../src/lib/founding";
import { applyBillingEvent } from "../src/lib/payments";
import { FOUNDING_CAP } from "../src/lib/plans";
import { addUtcMonths, grantDueSubscriptionRefills } from "../src/lib/subscription-refill";

/**
 * Cap race, refund, and lifetime refill on Postgres. Included by
 * vitest.postgres.config.ts with the billing Postgres job. `npm test` skips it.
 */
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  throw new Error(
    "founding postgres tests require DATABASE_URL to be a postgres:// or postgresql:// URL. Run npm run test:postgres.",
  );
}

beforeAll(async () => {
  const db = await getDb();
  expect(db.dialect).toBe("postgres");
});

beforeEach(async () => {
  const db = await getDb();
  await db.run(`DELETE FROM founding_spots`);
});

function nonce(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

async function createUser(): Promise<string> {
  const id = nonce("usr");
  const db = await getDb();
  await db.run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, NULL, ?)`, [
    id,
    `${id}@founding-pg.test`,
    new Date().toISOString(),
  ]);
  return id;
}

describe("founding on postgres", () => {
  it("never reserves more than 100 spots under concurrent checkout", async () => {
    const db = await getDb();
    await db.run(`DELETE FROM founding_spots`);
    const users = await Promise.all(Array.from({ length: FOUNDING_CAP + 20 }, () => createUser()));
    const results = await Promise.allSettled(users.map((userId) => reserveFoundingSpot(userId)));
    const ok = results.filter((result) => result.status === "fulfilled");
    const denied = results.filter((result) => result.status === "rejected");
    expect(ok).toHaveLength(FOUNDING_CAP);
    expect(denied).toHaveLength(20);
    const row = await db.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM founding_spots WHERE status = 'reserved'`,
    );
    expect(Number(row?.n)).toBe(FOUNDING_CAP);
  }, 120_000);

  it("frees the spot when a founding charge is refunded", async () => {
    const userId = await createUser();
    const sessionId = nonce("cs");
    const paymentIntentId = nonce("pi");
    const hold = await reserveFoundingSpot(userId);
    const db = await getDb();
    await db.run(`UPDATE founding_spots SET checkout_session_id = ? WHERE id = ?`, [sessionId, hold.spotId]);
    const paid = await applyBillingEvent({
      id: nonce("evt"),
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          client_reference_id: userId,
          payment_status: "paid",
          mode: "payment",
          payment_intent: paymentIntentId,
          metadata: { user_id: userId, sku: "founding_lifetime", lookup_key: "founding_lifetime" },
          line_items: { data: [{ price: { id: "price_founding", lookup_key: "founding_lifetime" } }] },
        },
      },
    });
    expect(paid).toMatchObject({ duplicate: false });
    expect((await getUserPlan(userId)).interval).toBe("lifetime");
    const refunded = await applyBillingEvent({
      id: nonce("evt"),
      type: "charge.refunded",
      data: {
        object: { id: nonce("ch"), payment_intent: paymentIntentId, amount: 14900, amount_refunded: 14900 },
      },
    });
    expect(refunded.duplicate).toBe(false);
    expect((await getUserPlan(userId)).plan.id).toBe("payg");
    const open = await db.get(
      `SELECT id FROM founding_spots WHERE user_id = ? AND status IN ('reserved', 'confirmed')`,
      [userId],
    );
    expect(open).toBeUndefined();
    const next = await reserveFoundingSpot(userId);
    expect(next.spotId).toEqual(expect.any(String));
  });

  it("refills lifetime Pro and ignores a later invoice for another subscription", async () => {
    const userId = await createUser();
    const anchor = new Date("2026-02-01T00:00:00.000Z");
    const sessionId = nonce("cs");
    await confirmFoundingPayment({
      userId,
      sessionId,
      paymentIntentId: nonce("pi"),
      now: anchor,
    });
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    const due = await grantDueSubscriptionRefills({ userId, now: addUtcMonths(anchor, 1) });
    expect(due.granted).toBe(1);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    expect((await getUserPlan(userId)).interval).toBe("lifetime");

    const invoiced = await applyBillingEvent({
      id: nonce("evt"),
      type: "invoice.paid",
      data: {
        object: {
          id: nonce("in"),
          amount_paid: 1100,
          currency: "eur",
          billing_reason: "subscription_cycle",
          metadata: {},
          parent: {
            subscription_details: {
              metadata: { user_id: userId, sku: "subscription_month" },
              subscription: "sub_not_founding",
            },
          },
          lines: {
            data: [
              {
                pricing: { price_details: { price: { id: "price_dit_pro_monthly", lookup_key: "dit_pro_monthly" } } },
              },
            ],
          },
        },
      },
    });
    expect(invoiced.duplicate).toBe(false);
    expect((await getUserPlan(userId)).interval).toBe("lifetime");
    expect((await getUserPlan(userId)).plan.id).toBe("subscription");
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5 });
    const db = await getDb();
    const stored = await db.get<{ stripe_subscription_id: string }>(
      `SELECT stripe_subscription_id FROM user_plans WHERE user_id = ?`,
      [userId],
    );
    expect(stored?.stripe_subscription_id).toBe(foundingSubscriptionId(userId));
  });
});
