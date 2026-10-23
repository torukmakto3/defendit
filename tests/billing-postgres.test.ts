import { randomBytes } from "crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getBalance, renewPlan } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import { applyBillingEvent } from "../src/lib/payments";
import {
  setCardFingerprintLoaderForTests,
  setInvoicePaymentLoaderForTests,
} from "../src/lib/stripe-client";

/**
 * These paths return 500 on Postgres and succeed on SQLite. `npm test` does
 * not run this file. CI runs it with `npm run test:postgres` against postgres:16.
 */
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  throw new Error(
    "billing postgres tests require DATABASE_URL to be a postgres:// or postgresql:// URL. Run npm run test:postgres.",
  );
}

beforeAll(async () => {
  const db = await getDb();
  expect(db.dialect).toBe("postgres");
});

afterEach(() => {
  setInvoicePaymentLoaderForTests(null);
  setCardFingerprintLoaderForTests(null);
});

function nonce(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

async function createUser(): Promise<string> {
  const id = nonce("usr");
  const db = await getDb();
  await db.run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, NULL, ?)`, [
    id,
    `${id}@billing-pg.test`,
    new Date().toISOString(),
  ]);
  return id;
}

function invoicePaid(input: {
  userId: string;
  sku: string;
  subscriptionId: string;
  invoiceId?: string;
  periodStart?: number;
  periodEnd?: number;
  anchor?: number;
}) {
  const invoiceId = input.invoiceId ?? nonce("in");
  const lookupKey = input.sku === "subscription_year" ? "dit_pro_yearly" : "dit_pro_monthly";
  return {
    id: nonce("evt"),
    type: "invoice.paid" as const,
    data: {
      object: {
        id: invoiceId,
        amount_paid: input.sku === "subscription_year" ? 9900 : 1100,
        currency: "eur",
        billing_reason: "subscription_create",
        period_start: input.periodStart,
        period_end: input.periodEnd,
        metadata: { sku: "defense", user_id: "not-the-buyer" },
        parent: {
          subscription_details: {
            metadata: { user_id: input.userId, sku: input.sku },
            subscription: input.subscriptionId,
            billing_cycle_anchor: input.anchor,
          },
        },
        lines: {
          data: [
            {
              period:
                input.periodStart != null && input.periodEnd != null
                  ? { start: input.periodStart, end: input.periodEnd }
                  : undefined,
              pricing: {
                price_details: { price: { id: `price_${lookupKey}`, lookup_key: lookupKey } },
              },
            },
          ],
        },
      },
    },
  };
}

interface StoredPlan {
  plan_id: string;
  interval: string | null;
  status: string;
  stripe_subscription_id: string | null;
  cancel_at_period_end: number | string;
  grant_anchor: string | null;
}

async function storedPlan(userId: string): Promise<StoredPlan> {
  const row = await (await getDb()).get<StoredPlan>(
    `SELECT plan_id, interval, status, stripe_subscription_id, cancel_at_period_end, grant_anchor
     FROM user_plans WHERE user_id = ?`,
    [userId],
  );
  if (!row) throw new Error("plan row missing");
  return row;
}

async function grantMonthly(
  userId: string,
  subscriptionId: string,
  payment: { chargeId: string | null; paymentIntentId: string | null },
): Promise<void> {
  setCardFingerprintLoaderForTests(async () => null);
  setInvoicePaymentLoaderForTests(async () => payment);
  const result = await applyBillingEvent(
    invoicePaid({ userId, sku: "subscription_month", subscriptionId }),
  );
  expect(result).toMatchObject({ duplicate: false });
  expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
}

describe("postgres monthly renewal", () => {
  it("grants a monthly plan from invoice.paid", async () => {
    const userId = await createUser();
    const subscriptionId = nonce("sub");
    await grantMonthly(userId, subscriptionId, {
      chargeId: nonce("ch"),
      paymentIntentId: nonce("pi"),
    });
    const plan = await storedPlan(userId);
    expect(plan.plan_id).toBe("subscription");
    expect(plan.interval).toBe("month");
    expect(plan.status).toBe("active");
    expect(plan.stripe_subscription_id).toBe(subscriptionId);
    expect(Number(plan.cancel_at_period_end)).toBe(0);
  });

  it("keeps cancel_at_period_end when a renewal does not activate", async () => {
    const userId = await createUser();
    const subscriptionId = nonce("sub");
    await grantMonthly(userId, subscriptionId, { chargeId: nonce("ch"), paymentIntentId: nonce("pi") });
    await (await getDb()).run(`UPDATE user_plans SET cancel_at_period_end = 1 WHERE user_id = ?`, [userId]);
    await renewPlan({
      userId,
      planId: "subscription",
      interval: "month",
      periodId: nonce("period"),
      subscriptionId,
      activate: false,
    });
    const plan = await storedPlan(userId);
    expect(plan.status).toBe("active");
    expect(plan.stripe_subscription_id).toBe(subscriptionId);
    expect(Number(plan.cancel_at_period_end)).toBe(1);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5 });
  });
});

describe("postgres clawback", () => {
  const cases = [
    { label: "charge id only", chargeId: true, paymentIntentId: false },
    { label: "payment intent only", chargeId: false, paymentIntentId: true },
    { label: "both ids", chargeId: true, paymentIntentId: true },
  ] as const;

  for (const row of cases) {
    it(`refunds a grant matched by ${row.label}`, async () => {
      const userId = await createUser();
      const chargeId = row.chargeId ? nonce("ch") : null;
      const paymentIntentId = row.paymentIntentId ? nonce("pi") : null;
      await grantMonthly(userId, nonce("sub"), { chargeId, paymentIntentId });
      const eventCharge = chargeId ?? nonce("ch_unmatched");
      const result = await applyBillingEvent({
        id: nonce("evt"),
        type: "charge.refunded",
        data: {
          object: {
            id: eventCharge,
            payment_intent: paymentIntentId,
            amount: 1100,
            amount_refunded: 1100,
          },
        },
      });
      expect(result).toEqual({ duplicate: false, unmatched: false });
      expect(await getBalance(userId)).toMatchObject({ defense: 0, challenge: 0 });
      const grants = await (await getDb()).all<{ refunded_at: string | null }>(
        `SELECT refunded_at FROM stripe_grants WHERE user_id = ?`,
        [userId],
      );
      expect(grants.length).toBeGreaterThan(0);
      expect(grants.every((grant) => grant.refunded_at)).toBe(true);
    });

    it(`disputes a grant matched by ${row.label}`, async () => {
      const userId = await createUser();
      const chargeId = row.chargeId ? nonce("ch") : null;
      const paymentIntentId = row.paymentIntentId ? nonce("pi") : null;
      await grantMonthly(userId, nonce("sub"), { chargeId, paymentIntentId });
      const result = await applyBillingEvent({
        id: nonce("evt"),
        type: "charge.dispute.created",
        data: {
          object: {
            id: nonce("dp"),
            charge: chargeId,
            payment_intent: paymentIntentId,
          },
        },
      });
      expect(result).toEqual({ duplicate: false, unmatched: false });
      expect(await getBalance(userId)).toMatchObject({ defense: 0, challenge: 0 });
      const flag = await (await getDb()).get<{ flag_reason: string }>(
        `SELECT flag_reason FROM billing_profiles WHERE user_id = ?`,
        [userId],
      );
      expect(flag?.flag_reason).toBe("dispute_opened");
    });
  }
});

describe("postgres subscription scope", () => {
  const anchor = Math.floor(Date.UTC(2026, 0, 15) / 1000);
  const periodEnd = Math.floor(Date.UTC(2027, 0, 15) / 1000);

  async function grantYear(userId: string, subscriptionId: string): Promise<void> {
    setCardFingerprintLoaderForTests(async () => null);
    setInvoicePaymentLoaderForTests(async () => ({
      paymentIntentId: nonce("pi"),
      chargeId: nonce("ch"),
    }));
    const result = await applyBillingEvent(
      invoicePaid({
        userId,
        sku: "subscription_year",
        subscriptionId,
        periodStart: anchor,
        periodEnd,
        anchor,
      }),
    );
    expect(result).toMatchObject({ duplicate: false });
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    const plan = await storedPlan(userId);
    expect(plan).toMatchObject({
      plan_id: "subscription",
      interval: "year",
      status: "active",
      stripe_subscription_id: subscriptionId,
    });
  }

  function subscriptionEvent(input: {
    type: "customer.subscription.deleted" | "customer.subscription.updated";
    subscriptionId: string;
    userId: string;
    status: string;
    sku?: string;
    cancelAtPeriodEnd?: boolean;
    shiftWindow?: boolean;
  }) {
    return {
      id: nonce("evt"),
      type: input.type,
      created: 50,
      data: {
        object: {
          id: input.subscriptionId,
          status: input.status,
          cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
          metadata: { user_id: input.userId, ...(input.sku ? { sku: input.sku } : {}) },
          billing_cycle_anchor: input.shiftWindow ? anchor + 86_400 : undefined,
          current_period_start: input.shiftWindow ? anchor + 86_400 : undefined,
          current_period_end: input.shiftWindow ? periodEnd + 86_400 : undefined,
        },
      },
    };
  }

  async function expectYearUntouched(userId: string, subscriptionId: string, grantAnchor: string | null) {
    const plan = await storedPlan(userId);
    expect(plan).toMatchObject({
      plan_id: "subscription",
      interval: "year",
      status: "active",
      stripe_subscription_id: subscriptionId,
    });
    expect(plan.grant_anchor).toBe(grantAnchor);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
  }

  it("ignores a stale delete, incomplete update, and failed invoice", async () => {
    const userId = await createUser();
    const subscriptionId = nonce("sub");
    await grantYear(userId, subscriptionId);
    const before = await storedPlan(userId);

    await applyBillingEvent(
      subscriptionEvent({
        type: "customer.subscription.deleted",
        subscriptionId: nonce("sub_old"),
        userId,
        status: "canceled",
        sku: "subscription_month",
      }),
    );
    await applyBillingEvent(
      subscriptionEvent({
        type: "customer.subscription.updated",
        subscriptionId: nonce("sub_incomplete"),
        userId,
        status: "incomplete",
        sku: "subscription_month",
      }),
    );
    await applyBillingEvent(
      subscriptionEvent({
        type: "customer.subscription.updated",
        subscriptionId: nonce("sub_old_month"),
        userId,
        status: "canceled",
        sku: "subscription_month",
      }),
    );
    await applyBillingEvent(
      subscriptionEvent({
        type: "customer.subscription.updated",
        subscriptionId: nonce("sub_old_year"),
        userId,
        status: "active",
        sku: "subscription_year",
        shiftWindow: true,
      }),
    );
    await applyBillingEvent({
      id: nonce("evt"),
      type: "invoice.payment_failed",
      data: {
        object: {
          id: nonce("in"),
          parent: {
            subscription_details: {
              subscription: nonce("sub_other"),
              metadata: { user_id: userId },
            },
          },
        },
      },
    });
    await applyBillingEvent(
      subscriptionEvent({
        type: "customer.subscription.updated",
        subscriptionId: nonce("sub_pastdue"),
        userId,
        status: "past_due",
      }),
    );

    await expectYearUntouched(userId, subscriptionId, before.grant_anchor);
  });

  it("still updates, marks past due, and ends the current subscription", async () => {
    const userId = await createUser();
    const subscriptionId = nonce("sub");
    await grantYear(userId, subscriptionId);

    await applyBillingEvent(
      subscriptionEvent({
        type: "customer.subscription.updated",
        subscriptionId,
        userId,
        status: "active",
        sku: "subscription_year",
        cancelAtPeriodEnd: true,
      }),
    );
    let plan = await storedPlan(userId);
    expect(plan).toMatchObject({
      interval: "year",
      status: "active",
      stripe_subscription_id: subscriptionId,
    });
    expect(Number(plan.cancel_at_period_end)).toBe(1);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });

    await applyBillingEvent({
      id: nonce("evt"),
      type: "invoice.payment_failed",
      data: {
        object: {
          id: nonce("in"),
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { user_id: userId, sku: "subscription_year" },
            },
          },
        },
      },
    });
    plan = await storedPlan(userId);
    expect(plan.status).toBe("past_due");
    expect(plan.stripe_subscription_id).toBe(subscriptionId);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });

    const ended = await createUser();
    const endedSub = nonce("sub");
    await grantYear(ended, endedSub);
    await applyBillingEvent(
      subscriptionEvent({
        type: "customer.subscription.deleted",
        subscriptionId: endedSub,
        userId: ended,
        status: "canceled",
        sku: "subscription_year",
      }),
    );
    const after = await storedPlan(ended);
    expect(after.plan_id).toBe("payg");
    expect(after.status).toBe("canceled");
    expect(after.stripe_subscription_id).toBe(endedSub);
    expect(await getBalance(ended)).toMatchObject({ defense: 0, challenge: 0 });
  });
});
