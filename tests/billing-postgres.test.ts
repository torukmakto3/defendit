import { randomBytes } from "crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ALREADY_FOUNDING_MESSAGE,
  FOUNDING_AFTER_CANCEL_MESSAGE,
  LIFETIME_BLOCKS_SUBSCRIPTION_MESSAGE,
  SECOND_SUBSCRIPTION_MESSAGE,
} from "../src/lib/checkout-gate";
import { getBalance, renewPlan } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import { applyBillingEvent, createCheckout } from "../src/lib/payments";
import { skuPriceCents } from "../src/lib/plans";
import { rateLimit } from "../src/lib/ratelimit";
import { setStripeCheckoutApiForTests } from "../src/lib/stripe-checkout";
import {
  setCardFingerprintLoaderForTests,
  setInvoicePaymentLoaderForTests,
} from "../src/lib/stripe-client";
import { setStripePriceClientForTests, skuForLookupKey } from "../src/lib/stripe-prices";

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

  it("keeps an active yearly plan when another subscription's monthly invoice is paid", async () => {
    const userId = await createUser();
    const yearlyId = nonce("sub");
    await grantYear(userId, yearlyId);
    const planSql = `SELECT plan_id, interval, status, period_id, stripe_subscription_id, cancel_at_period_end,
            grant_anchor, current_period_start, current_period_end, last_granted_period_index
     FROM user_plans WHERE user_id = ?`;
    const before = await (await getDb()).get(planSql, [userId]);

    setCardFingerprintLoaderForTests(async () => null);
    setInvoicePaymentLoaderForTests(async () => ({
      paymentIntentId: nonce("pi"),
      chargeId: nonce("ch"),
    }));
    const paid = await applyBillingEvent(
      invoicePaid({
        userId,
        sku: "subscription_month",
        subscriptionId: nonce("sub"),
      }),
    );
    expect(paid).toMatchObject({ duplicate: false });

    const after = await (await getDb()).get(planSql, [userId]);
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      plan_id: "subscription",
      interval: "year",
      status: "active",
      stripe_subscription_id: yearlyId,
    });
    const grant = await (await getDb()).get<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM credit_ledger WHERE user_id = ? AND idempotency_key LIKE 'renew:%:defense'`,
      [userId],
    );
    expect(grant?.idempotency_key).toMatch(/^renew:stripe:/);
  });
});

describe("postgres billing guards", () => {
  async function notice(userId: string): Promise<string | null> {
    const row = await (await getDb()).get<{ payment_notice: string | null }>(
      `SELECT payment_notice FROM billing_profiles WHERE user_id = ?`,
      [userId],
    );
    return row?.payment_notice ?? null;
  }

  it("sets the payment-failed notice only for the subscription stored on the plan", async () => {
    const userId = await createUser();
    const subscriptionId = nonce("sub");
    await grantMonthly(userId, subscriptionId, { chargeId: nonce("ch"), paymentIntentId: nonce("pi") });

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
    expect(await notice(userId)).toBeNull();
    expect((await storedPlan(userId)).status).toBe("active");

    await applyBillingEvent({
      id: nonce("evt"),
      type: "invoice.payment_failed",
      data: {
        object: {
          id: nonce("in"),
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { user_id: userId, sku: "subscription_month" },
            },
          },
        },
      },
    });
    expect((await storedPlan(userId)).status).toBe("past_due");
    expect(await notice(userId)).toMatch(/Payment failed/);

    await applyBillingEvent({
      id: nonce("evt"),
      type: "invoice.payment_failed",
      data: {
        object: {
          id: nonce("in"),
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { user_id: userId },
            },
          },
        },
      },
    });
    expect((await storedPlan(userId)).status).toBe("past_due");
    expect(await notice(userId)).toMatch(/billing portal/);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
  });

  it("refuses a second subscription and founding checkout on postgres", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    const seen: string[] = [];
    setStripeCheckoutApiForTests({
      async createSession(input) {
        seen.push(input.sku);
        return { id: nonce("cs"), url: "https://checkout.stripe.com/c/pay/cs_pg" };
      },
    });
    setStripePriceClientForTests({
      async list(lookupKeys) {
        return lookupKeys.map((key) => {
          const sku = skuForLookupKey(key);
          return {
            id: `price_${key}`,
            lookup_key: key,
            currency: "eur",
            unit_amount: sku ? skuPriceCents(sku) : 250,
            product: { id: `prod_${key}`, name: key },
          };
        });
      },
    });
    try {
      const userId = await createUser();
      const subscriptionId = nonce("sub");
      await grantMonthly(userId, subscriptionId, { chargeId: null, paymentIntentId: null });
      await expect(createCheckout({ userId, sku: "subscription_year" })).rejects.toMatchObject({
        status: 409,
        message: SECOND_SUBSCRIPTION_MESSAGE,
      });
      await expect(createCheckout({ userId, sku: "team_month" })).rejects.toMatchObject({ status: 409 });
      await expect(createCheckout({ userId, sku: "founding_lifetime" })).rejects.toMatchObject({
        status: 409,
        message: FOUNDING_AFTER_CANCEL_MESSAGE,
      });
      const spots = await (await getDb()).get<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM founding_spots WHERE user_id = ?`,
        [userId],
      );
      expect(Number(spots?.n ?? 0)).toBe(0);
      await (await getDb()).run(`UPDATE user_plans SET status = 'trialing' WHERE user_id = ?`, [userId]);
      await expect(createCheckout({ userId, sku: "subscription_month" })).rejects.toMatchObject({ status: 409 });
      const defense = await createCheckout({ userId, sku: "defense" });
      expect(defense.url).toContain("checkout.stripe.com");
      expect(seen).toEqual(["defense"]);

      const founder = await createUser();
      await (await getDb()).run(
        `INSERT INTO user_plans
          (user_id, plan_id, interval, status, period_id, current_period_end, stripe_subscription_id, cancel_at_period_end, updated_at)
         VALUES (?, 'subscription', 'lifetime', 'active', NULL, NULL, ?, 0, ?)`,
        [founder, `founding_${founder}`, new Date().toISOString()],
      );
      await expect(createCheckout({ userId: founder, sku: "subscription_month" })).rejects.toMatchObject({
        status: 409,
        message: LIFETIME_BLOCKS_SUBSCRIPTION_MESSAGE,
      });
      await expect(createCheckout({ userId: founder, sku: "subscription_year" })).rejects.toMatchObject({
        status: 409,
      });
      await expect(createCheckout({ userId: founder, sku: "team_month" })).rejects.toMatchObject({ status: 409 });
      await expect(createCheckout({ userId: founder, sku: "founding_lifetime" })).rejects.toMatchObject({
        status: 409,
        message: ALREADY_FOUNDING_MESSAGE,
      });
      expect(seen).toEqual(["defense"]);
    } finally {
      setStripeCheckoutApiForTests(null);
      setStripePriceClientForTests(null);
      delete process.env.BILLING_ENABLED;
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it("does not count a rejected checkout retry or move its window", async () => {
    const userId = await createUser();
    const key = `checkout:${userId}`;
    expect((await rateLimit(key, 2, 3600)).ok).toBe(true);
    expect((await rateLimit(key, 2, 3600)).ok).toBe(true);
    const before = await (await getDb()).get<{ count: number | string; window_start: string }>(
      `SELECT count, window_start FROM rate_limits WHERE bucket_key = ?`,
      [key],
    );
    expect(Number(before?.count)).toBe(2);
    expect((await rateLimit(key, 2, 3600)).ok).toBe(false);
    expect((await rateLimit(key, 2, 3600)).ok).toBe(false);
    const after = await (await getDb()).get<{ count: number | string; window_start: string }>(
      `SELECT count, window_start FROM rate_limits WHERE bucket_key = ?`,
      [key],
    );
    expect(Number(after?.count)).toBe(2);
    expect(after?.window_start).toBe(before?.window_start);
  });
});
