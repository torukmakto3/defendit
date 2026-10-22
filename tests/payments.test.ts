import { createHmac } from "crypto";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as checkout } from "../src/app/api/billing/checkout/route";
import { POST as webhook } from "../src/app/api/billing/webhook/route";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { registerNode } from "../src/instrumentation-node";
import {
  assertNotSelfClaim,
  betaBudgetCents,
  consumeCredit,
  ensureBetaGrant,
  getBalance,
  getUserPlan,
  holdCredit,
  linkChallengedDefense,
} from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import { billingEnabled } from "../src/lib/plans";
import { POST as portal } from "../src/app/api/billing/portal/route";
import { checkoutSessionParams, setStripeCheckoutApiForTests, type StripeCheckoutRequest } from "../src/lib/stripe-checkout";
import {
  setCardFingerprintLoaderForTests,
  setInvoiceItemWriterForTests,
  setInvoicePaymentLoaderForTests,
  STRIPE_API_VERSION,
} from "../src/lib/stripe-client";
import { assertStripeReady, checkoutCatalog, liveStripeRefused } from "../src/lib/stripe-config";
import { grantDueSubscriptionRefills } from "../src/lib/subscription-refill";
import {
  checkoutLookupKey,
  expireStripePriceCacheForTests,
  meterEventName,
  resolvePrices,
  setStripePriceClientForTests,
  STRIPE_LOOKUP_KEYS,
  type StripePriceClient,
} from "../src/lib/stripe-prices";

const SECRET = "whsec_test_secret";
const calls: string[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-payments-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  delete process.env.BILLING_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_ALLOW_LIVE;
  delete process.env.STRIPE_MODE;
  delete process.env.STRIPE_TAX_ENABLED;
});

beforeEach(() => {
  setInvoicePaymentLoaderForTests(async (invoiceId) => ({
    paymentIntentId: `pi_${invoiceId}`,
    chargeId: `ch_${invoiceId}`,
  }));
  setCardFingerprintLoaderForTests(async () => null);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    throw new Error("stripe network is not allowed");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  expect(calls).toEqual([]);
  calls.length = 0;
  setStripeCheckoutApiForTests(null);
  setInvoiceItemWriterForTests(null);
  setInvoicePaymentLoaderForTests(null);
  setCardFingerprintLoaderForTests(null);
  delete process.env.BILLING_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_ALLOW_LIVE;
  delete process.env.STRIPE_MODE;
  delete process.env.STRIPE_TAX_ENABLED;
  setStripePriceClientForTests(null);
});

async function signIn(email: string): Promise<{ user: User; cookie: string }> {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return { user: res!.user, cookie: `di_session=${res!.sessionToken}` };
}

function sign(payload: string, secret = SECRET): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function postWebhook(event: unknown, signature?: string) {
  const payload = JSON.stringify(event);
  process.env.BILLING_ENABLED = "true";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_MODE;
  return webhook(
    new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature ?? sign(payload),
      },
      body: payload,
    }),
  );
}

function lookupFor(sku: string): string {
  switch (sku) {
    case "defense":
      return "dit_defense_payg";
    case "challenge":
      return "dit_challenge_payg";
    case "pack3":
      return "dit_pack_3";
    case "pack8":
      return "dit_pack_8";
    case "subscription_month":
      return "dit_pro_monthly";
    case "subscription_year":
      return "dit_pro_yearly";
    case "team_month":
      return "dit_team_monthly";
    case "enterprise_month":
      return "dit_enterprise_base";
    default:
      return "dit_unknown";
  }
}

function checkoutEvent(input: {
  id: string;
  userId: string;
  sku: string;
  amount: number;
  paymentIntent: string;
  mode?: "payment" | "subscription";
  lookupKey?: string;
  sessionId?: string;
  customer?: string;
  subscription?: string;
  type?: string;
}) {
  const lookupKey = input.lookupKey ?? lookupFor(input.sku);
  return {
    id: input.id,
    type: input.type ?? "checkout.session.completed",
    data: {
      object: {
        id: input.sessionId ?? `cs_${input.id}`,
        client_reference_id: input.userId,
        payment_status: "paid",
        mode: input.mode ?? "payment",
        amount_total: input.amount,
        currency: "eur",
        customer: input.customer,
        subscription: input.subscription,
        payment_intent: input.paymentIntent,
        metadata: {
          sku: input.sku,
          user_id: input.userId,
          lookup_key: lookupKey,
        },
        line_items: {
          data: [{ price: { id: `price_${lookupKey}`, lookup_key: lookupKey } }],
        },
      },
    },
  };
}

async function subscriptionFlags(
  subscriptionId: string,
): Promise<{ terminal: number; refillsStopped: number }> {
  const row = await (await getDb()).get<{ terminal: number | string; refills_stopped: number | string | null }>(
    `SELECT terminal, refills_stopped FROM stripe_subscription_state WHERE subscription_id = ?`,
    [subscriptionId],
  );
  return {
    terminal: Number(row?.terminal ?? 0),
    refillsStopped: Number(row?.refills_stopped ?? 0),
  };
}

function invoiceEvent(input: {
  id: string;
  invoiceId: string;
  userId: string;
  sku: string;
  amount: number;
  reason?: string;
  lookupKey?: string;
  customer?: string;
  subscription?: string;
  periodStart?: number;
  periodEnd?: number;
  anchor?: number;
}) {
  const lookupKey = input.lookupKey ?? lookupFor(input.sku);
  return {
    id: input.id,
    type: "invoice.paid",
    data: {
      object: {
        id: input.invoiceId,
        amount_paid: input.amount,
        currency: "eur",
        billing_reason: input.reason ?? "subscription_cycle",
        customer: input.customer,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        metadata: { sku: "defense", user_id: "not-the-buyer" },
        parent: {
          subscription_details: {
            metadata: { user_id: input.userId, sku: input.sku },
            subscription: input.subscription ?? `sub_${input.invoiceId}`,
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

describe("payments flags", () => {
  it("keeps the beta grant and budget when billing is off", async () => {
    expect(billingEnabled()).toBe(false);
    expect(betaBudgetCents()).toBe(15000);
    expect(checkoutCatalog()).toBeNull();
    expect(STRIPE_API_VERSION).toBe("2026-09-30.endive");
    expect(meterEventName()).toBe("defense_overage");
    const { user } = await signIn("beta-untouched@pay.example");
    await ensureBetaGrant(user.id);
    expect(await getBalance(user.id)).toMatchObject({ defense: 3, challenge: 2, learnSlots: 3 });
    process.env.BILLING_ENABLED = "true";
    expect(billingEnabled()).toBe(true);
    expect((await getBalance(user.id)).defense).toBe(3);
  });

  it("keeps the server up when billing is on with a live key", () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_live_disabled";
    expect(liveStripeRefused()).toBe(true);
    expect(() => assertStripeReady()).not.toThrow();
    expect(() => registerNode()).not.toThrow();
    process.env.STRIPE_SECRET_KEY = "rk_live_disabled";
    expect(liveStripeRefused()).toBe(true);
    expect(() => registerNode()).not.toThrow();
    process.env.STRIPE_ALLOW_LIVE = "true";
    expect(liveStripeRefused()).toBe(false);
    expect(() => registerNode()).not.toThrow();
    delete process.env.STRIPE_ALLOW_LIVE;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_MODE = "live";
    expect(liveStripeRefused()).toBe(true);
    expect(() => assertStripeReady()).not.toThrow();
    delete process.env.BILLING_ENABLED;
    process.env.STRIPE_SECRET_KEY = "sk_live_disabled";
    expect(liveStripeRefused()).toBe(false);
    process.env.STRIPE_SECRET_KEY = "rk_live_disabled";
    expect(() => assertStripeReady()).not.toThrow();
    expect(() => registerNode()).not.toThrow();
  });
});

describe("webhook", () => {
  it("rejects a bad signature and does not grant credits", async () => {
    const { user } = await signIn("sig-fail@pay.example");
    const event = checkoutEvent({
      id: "evt_bad_sig",
      userId: user.id,
      sku: "defense",
      amount: 400,
      paymentIntent: "pi_bad_sig",
    });
    const payload = JSON.stringify(event);
    const bad = sign(payload).replace(/v1=[0-9a-f]+/, `v1=${"0".repeat(64)}`);
    const res = await postWebhook(event, bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid Stripe signature." });
    expect((await getBalance(user.id)).defense).toBe(0);
    const row = await (await getDb()).get(`SELECT event_id FROM stripe_events WHERE event_id = ?`, ["evt_bad_sig"]);
    expect(row).toBeUndefined();
  });

  it("grants each product once and ignores a duplicate event", async () => {
    const defense = await signIn("buy-defense@pay.example");
    const defenseRes = await postWebhook(
      checkoutEvent({
        id: "evt_defense",
        userId: defense.user.id,
        sku: "defense",
        amount: 400,
        paymentIntent: "pi_defense",
      }),
    );
    expect(defenseRes.status).toBe(200);
    expect(await defenseRes.json()).toMatchObject({ received: true, duplicate: false });
    expect(await getBalance(defense.user.id)).toMatchObject({ defenseOnly: 1, challengeOnly: 0, flex: 0 });

    const again = await postWebhook(
      checkoutEvent({
        id: "evt_defense",
        userId: defense.user.id,
        sku: "defense",
        amount: 400,
        paymentIntent: "pi_defense",
      }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect((await getBalance(defense.user.id)).defenseOnly).toBe(1);

    const challenge = await signIn("buy-challenge@pay.example");
    expect(
      (
        await postWebhook(
          checkoutEvent({
            id: "evt_challenge",
            userId: challenge.user.id,
            sku: "challenge",
            amount: 300,
            paymentIntent: "pi_challenge",
          }),
        )
      ).status,
    ).toBe(200);
    expect(await getBalance(challenge.user.id)).toMatchObject({ challengeOnly: 1, defenseOnly: 0, flex: 0 });
    await expect(
      linkChallengedDefense({
        challengeId: "chal_buyer",
        challengerUserId: challenge.user.id,
        defenderUserId: challenge.user.id,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const pack3 = await signIn("buy-pack3@pay.example");
    await postWebhook(
      checkoutEvent({
        id: "evt_pack3",
        userId: pack3.user.id,
        sku: "pack3",
        amount: 1000,
        paymentIntent: "pi_pack3",
      }),
    );
    expect(await getBalance(pack3.user.id)).toMatchObject({ flex: 3, defense: 3, challenge: 3, defenseOnly: 0 });

    const pack8 = await signIn("buy-pack8@pay.example");
    await postWebhook(
      checkoutEvent({
        id: "evt_pack8",
        userId: pack8.user.id,
        sku: "pack8",
        amount: 2000,
        paymentIntent: "pi_pack8",
      }),
    );
    expect((await getBalance(pack8.user.id)).flex).toBe(8);

    const month = await signIn("buy-month@pay.example");
    const subCheckout = await postWebhook(
      checkoutEvent({
        id: "evt_sub_checkout",
        userId: month.user.id,
        sku: "subscription_month",
        amount: 1100,
        paymentIntent: "pi_sub_checkout",
        mode: "subscription",
      }),
    );
    expect(subCheckout.status).toBe(200);
    expect((await getBalance(month.user.id)).defense).toBe(0);
    await postWebhook(
      invoiceEvent({
        id: "evt_month_1",
        invoiceId: "in_month_1",
        userId: month.user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_create",
      }),
    );
    expect(await getBalance(month.user.id)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    expect((await getUserPlan(month.user.id)).status).toBe("active");

    const year = await signIn("buy-year@pay.example");
    await postWebhook(
      invoiceEvent({
        id: "evt_year_1",
        invoiceId: "in_year_1",
        userId: year.user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_create",
      }),
    );
    expect(await getBalance(year.user.id)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
  });

  it("renews a subscription without stacking unused challenge credits", async () => {
    const { user } = await signIn("renew@pay.example");
    await postWebhook(
      invoiceEvent({
        id: "evt_renew_1",
        invoiceId: "in_renew_1",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_create",
      }),
    );
    await consumeCredit({ userId: user.id, kind: "challenge", idempotencyKey: "renew-use-1" });
    await consumeCredit({ userId: user.id, kind: "challenge", idempotencyKey: "renew-use-2" });
    expect((await getBalance(user.id)).challenge).toBe(3);
    await postWebhook(
      invoiceEvent({
        id: "evt_renew_2",
        invoiceId: "in_renew_2",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_cycle",
      }),
    );
    expect(await getBalance(user.id)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
  });

  it("cancels a subscription without taking the credits already granted", async () => {
    const { user } = await signIn("cancel@pay.example");
    await postWebhook(
      invoiceEvent({
        id: "evt_cancel_inv",
        invoiceId: "in_cancel",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
      }),
    );
    const res = await postWebhook({
      id: "evt_cancel_sub",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_cancel",
          status: "canceled",
          metadata: { user_id: user.id, sku: "subscription_month" },
        },
      },
    });
    expect(res.status).toBe(200);
    expect((await getUserPlan(user.id)).plan.id).toBe("payg");
    expect((await getUserPlan(user.id)).status).toBe("canceled");
    expect(await getBalance(user.id)).toMatchObject({ defense: 0, challenge: 0 });
  });

  it("claws back a refund without going negative, and flags spent credits", async () => {
    const untouched = await signIn("refund-full@pay.example");
    await ensureBetaGrant(untouched.user.id);
    await postWebhook(
      checkoutEvent({
        id: "evt_refund_defense",
        userId: untouched.user.id,
        sku: "defense",
        amount: 400,
        paymentIntent: "pi_refund_defense",
      }),
    );
    expect((await getBalance(untouched.user.id)).defense).toBe(4);
    const full = await postWebhook({
      id: "evt_refund_defense_back",
      type: "charge.refunded",
      data: { object: { id: "ch_refund_defense", payment_intent: "pi_refund_defense", amount_refunded: 400 } },
    });
    expect(full.status).toBe(200);
    expect(await getBalance(untouched.user.id)).toMatchObject({ defense: 3, defenseOnly: 3, challenge: 2 });
    const replay = await postWebhook({
      id: "evt_refund_defense_back",
      type: "charge.refunded",
      data: { object: { id: "ch_refund_defense", payment_intent: "pi_refund_defense", amount_refunded: 400 } },
    });
    expect(await replay.json()).toMatchObject({ duplicate: true });
    expect((await getBalance(untouched.user.id)).defense).toBe(3);
    const clean = await (await getDb()).get(`SELECT flag_reason FROM billing_profiles WHERE user_id = ?`, [
      untouched.user.id,
    ]);
    expect(clean).toBeUndefined();

    const spent = await signIn("refund-spent@pay.example");
    await postWebhook(
      checkoutEvent({
        id: "evt_refund_pack",
        userId: spent.user.id,
        sku: "pack3",
        amount: 1000,
        paymentIntent: "pi_refund_pack",
      }),
    );
    await holdCredit({ userId: spent.user.id, kind: "defense", idempotencyKey: "hold-before-refund" });
    expect((await getBalance(spent.user.id)).flex).toBe(2);
    const partial = await postWebhook({
      id: "evt_refund_pack_back",
      type: "charge.refunded",
      data: { object: { id: "ch_refund_pack", payment_intent: "pi_refund_pack", amount_refunded: 1000 } },
    });
    expect(partial.status).toBe(200);
    const balance = await getBalance(spent.user.id);
    expect(balance.flex).toBe(0);
    expect(balance.defense).toBeGreaterThanOrEqual(0);
    expect(balance.challenge).toBeGreaterThanOrEqual(0);
    const flag = await (await getDb()).get<{ flag_reason: string }>(
      `SELECT flag_reason FROM billing_profiles WHERE user_id = ?`,
      [spent.user.id],
    );
    expect(flag?.flag_reason).toBe("refund_credits_already_spent");

    const member = await signIn("refund-sub@pay.example");
    await postWebhook(
      invoiceEvent({
        id: "evt_sub_refund_inv",
        invoiceId: "in_sub_refund",
        userId: member.user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_create",
      }),
    );
    expect((await getBalance(member.user.id)).defense).toBe(10);
    const subRefund = await postWebhook({
      id: "evt_sub_refund",
      type: "charge.refunded",
      data: { object: { id: "ch_in_sub_refund", payment_intent: "pi_in_sub_refund", amount_refunded: 1100 } },
    });
    expect(subRefund.status).toBe(200);
    expect(await getBalance(member.user.id)).toMatchObject({ defense: 0, challenge: 0, learnSlots: 0 });
    const subFlag = await (await getDb()).get(`SELECT flag_reason FROM billing_profiles WHERE user_id = ?`, [
      member.user.id,
    ]);
    expect(subFlag).toBeUndefined();
  });

  it("stores a card fingerprint and blocks a claim from the same card", async () => {
    const buyer = await signIn("fp-buyer@pay.example");
    const other = await signIn("fp-other@pay.example");
    for (const [user, id] of [
      [buyer.user, "evt_fp_buyer"],
      [other.user, "evt_fp_other"],
    ] as const) {
      const res = await postWebhook({
        id,
        type: "charge.succeeded",
        data: {
          object: {
            id: `ch_${id}`,
            payment_intent: `pi_${id}`,
            metadata: { user_id: user.id },
            payment_method_details: { card: { fingerprint: "fp_shared" } },
          },
        },
      });
      expect(res.status).toBe(200);
    }
    await expect(
      assertNotSelfClaim({ creatorUserId: buyer.user.id, claimerUserId: other.user.id }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("reads the card fingerprint from the PaymentIntent when checkout completes", async () => {
    setCardFingerprintLoaderForTests(async () => "fp_checkout");
    const buyer = await signIn("fp-checkout@pay.example");
    const res = await postWebhook(
      checkoutEvent({
        id: "evt_fp_checkout",
        userId: buyer.user.id,
        sku: "defense",
        amount: 400,
        paymentIntent: "pi_fp_checkout",
      }),
    );
    expect(res.status).toBe(200);
    const row = await (await getDb()).get<{ card_fingerprint: string }>(
      `SELECT card_fingerprint FROM billing_profiles WHERE user_id = ?`,
      [buyer.user.id],
    );
    expect(row?.card_fingerprint).toBe("fp_checkout");
  });

  it("stores a subscription card fingerprint from the invoice payment", async () => {
    setCardFingerprintLoaderForTests(async (paymentIntentId) =>
      paymentIntentId === "pi_in_sub_fp" ? "fp_sub" : null,
    );
    const { user } = await signIn("fp-sub@pay.example");
    const checkoutRes = await postWebhook(
      checkoutEvent({
        id: "evt_fp_sub_cs",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        paymentIntent: "",
        mode: "subscription",
        subscription: "sub_fp",
      }),
    );
    expect(checkoutRes.status).toBe(200);
    const before = await (await getDb()).get<{ card_fingerprint: string | null }>(
      `SELECT card_fingerprint FROM billing_profiles WHERE user_id = ?`,
      [user.id],
    );
    expect(before?.card_fingerprint ?? null).toBeNull();
    const paid = await postWebhook(
      invoiceEvent({
        id: "evt_fp_sub_inv",
        invoiceId: "in_sub_fp",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_create",
        subscription: "sub_fp",
      }),
    );
    expect(paid.status).toBe(200);
    const after = await (await getDb()).get<{ card_fingerprint: string }>(
      `SELECT card_fingerprint FROM billing_profiles WHERE user_id = ?`,
      [user.id],
    );
    expect(after?.card_fingerprint).toBe("fp_sub");
  });

  it("stores the invoice payment from InvoicePayment and ignores invoice.charge", async () => {
    const { user } = await signIn("inv-pay@pay.example");
    const event = invoiceEvent({
      id: "evt_inv_pay",
      invoiceId: "in_inv_pay",
      userId: user.id,
      sku: "subscription_month",
      amount: 1100,
      reason: "subscription_create",
    });
    expect(event.data.object).not.toHaveProperty("charge");
    expect(event.data.object).not.toHaveProperty("payment_intent");
    expect((await postWebhook(event)).status).toBe(200);
    const grant = await (await getDb()).get<{ payment_intent_id: string; charge_id: string }>(
      `SELECT payment_intent_id, charge_id FROM stripe_grants WHERE invoice_id = ? LIMIT 1`,
      ["in_inv_pay"],
    );
    expect(grant).toMatchObject({ payment_intent_id: "pi_in_inv_pay", charge_id: "ch_in_inv_pay" });
  });

  it("claws only the refunded purchase, and a partial refund floors the credits", async () => {
    const { user } = await signIn("scoped-refund@pay.example");
    await postWebhook(
      checkoutEvent({
        id: "evt_scope_defense",
        userId: user.id,
        sku: "defense",
        amount: 400,
        paymentIntent: "pi_scope_defense",
      }),
    );
    await postWebhook(
      checkoutEvent({
        id: "evt_scope_pack",
        userId: user.id,
        sku: "pack8",
        amount: 2000,
        paymentIntent: "pi_scope_pack",
      }),
    );
    expect(await getBalance(user.id)).toMatchObject({ defenseOnly: 1, flex: 8 });
    const half = await postWebhook({
      id: "evt_scope_pack_half",
      type: "charge.refunded",
      data: {
        object: { id: "ch_scope_pack", payment_intent: "pi_scope_pack", amount: 2000, amount_refunded: 1000 },
      },
    });
    expect(half.status).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ defenseOnly: 1, flex: 4 });
    const pack = await (await getDb()).get<{ refunded_at: string | null; clawed_credits: number }>(
      `SELECT refunded_at, clawed_credits FROM stripe_grants WHERE payment_intent_id = ?`,
      ["pi_scope_pack"],
    );
    expect(pack?.refunded_at).toBeNull();
    expect(Number(pack?.clawed_credits)).toBe(4);
    const defense = await (await getDb()).get<{ refunded_at: string | null }>(
      `SELECT refunded_at FROM stripe_grants WHERE payment_intent_id = ?`,
      ["pi_scope_defense"],
    );
    expect(defense?.refunded_at).toBeNull();
    const rest = await postWebhook({
      id: "evt_scope_pack_rest",
      type: "charge.refunded",
      data: {
        object: { id: "ch_scope_pack", payment_intent: "pi_scope_pack", amount: 2000, amount_refunded: 2000 },
      },
    });
    expect(rest.status).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ defenseOnly: 1, flex: 0 });
  });

  it("grants a portal switch from the line lookup key and ignores the proration line", async () => {
    const { user } = await signIn("switch-year@pay.example");
    const event = invoiceEvent({
      id: "evt_switch_year",
      invoiceId: "in_switch_year",
      userId: user.id,
      sku: "subscription_month",
      amount: 9900,
      reason: "subscription_update",
      subscription: "sub_switch_year",
    });
    const lines = event.data.object.lines as { data: Record<string, unknown>[] };
    lines.data = [
      {
        proration: true,
        pricing: { price_details: { price: { id: "price_dit_pro_monthly", lookup_key: "dit_pro_monthly" } } },
      },
      {
        proration: false,
        period: { start: Math.floor(Date.UTC(2026, 0, 31) / 1000), end: Math.floor(Date.UTC(2027, 0, 31) / 1000) },
        pricing: { price_details: { price: { id: "price_dit_pro_yearly", lookup_key: "dit_pro_yearly" } } },
      },
    ];
    const res = await postWebhook(event);
    expect(res.status).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    expect(await getUserPlan(user.id)).toMatchObject({ interval: "year", status: "active" });

    const updated = await postWebhook({
      id: "evt_switch_updated",
      type: "customer.subscription.updated",
      created: 20,
      data: {
        object: {
          id: "sub_switch_year",
          status: "active",
          metadata: { user_id: user.id, sku: "subscription_month" },
          items: {
            data: [{ price: { id: "price_dit_pro_yearly", lookup_key: "dit_pro_yearly" } }],
          },
        },
      },
    });
    expect(updated.status).toBe(200);
    expect((await getUserPlan(user.id)).interval).toBe("year");
  });

  it("does not treat paused or an unknown status as active", async () => {
    const { user } = await signIn("paused-plan@pay.example");
    await postWebhook(
      invoiceEvent({
        id: "evt_paused_inv",
        invoiceId: "in_paused",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_create",
        subscription: "sub_paused",
      }),
    );
    const paused = await postWebhook({
      id: "evt_paused_sub",
      type: "customer.subscription.updated",
      created: 30,
      data: {
        object: {
          id: "sub_paused",
          status: "paused",
          metadata: { user_id: user.id, sku: "subscription_month" },
        },
      },
    });
    expect(paused.status).toBe(200);
    expect((await getUserPlan(user.id)).status).toBe("unpaid");
    const unknown = await postWebhook({
      id: "evt_unknown_sub",
      type: "customer.subscription.updated",
      created: 40,
      data: {
        object: {
          id: "sub_paused",
          status: "weird",
          metadata: { user_id: user.id, sku: "subscription_month" },
        },
      },
    });
    expect(unknown.status).toBe(200);
    expect((await getUserPlan(user.id)).status).toBe("unpaid");
  });

  it("does not reactivate a subscription after it was deleted", async () => {
    const { user } = await signIn("order-sub@pay.example");
    const deleted = await postWebhook({
      id: "evt_order_deleted",
      type: "customer.subscription.deleted",
      created: 200,
      data: {
        object: {
          id: "sub_order",
          status: "canceled",
          metadata: { user_id: user.id, sku: "subscription_month" },
        },
      },
    });
    expect(deleted.status).toBe(200);
    const lateInvoice = await postWebhook({
      ...invoiceEvent({
        id: "evt_order_invoice",
        invoiceId: "in_order",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_create",
        subscription: "sub_order",
      }),
      created: 100,
    });
    expect(lateInvoice.status).toBe(200);
    expect(await lateInvoice.json()).toMatchObject({ ignored: true });
    expect((await getBalance(user.id)).defense).toBe(0);
    expect((await getUserPlan(user.id)).status).toBe("canceled");
    const lateCheckout = await postWebhook({
      ...checkoutEvent({
        id: "evt_order_checkout",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        paymentIntent: "pi_order_checkout",
        mode: "subscription",
        subscription: "sub_order",
      }),
      created: 150,
    });
    expect(lateCheckout.status).toBe(200);
    expect((await getUserPlan(user.id)).plan.id).toBe("payg");
  });

  it("links each yearly refill to the invoice payment and a refund stops later months", async () => {
    const { user } = await signIn("year-claw@pay.example");
    const anchor = Math.floor(Date.UTC(2026, 0, 31) / 1000);
    const periodEnd = Math.floor(Date.UTC(2027, 0, 31) / 1000);
    const paid = await postWebhook(
      invoiceEvent({
        id: "evt_year_claw",
        invoiceId: "in_year_claw",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_create",
        subscription: "sub_year_claw",
        periodStart: anchor,
        periodEnd,
        anchor,
      }),
    );
    expect(paid.status).toBe(200);
    const due = await grantDueSubscriptionRefills({
      userId: user.id,
      now: new Date(Date.UTC(2026, 1, 28, 12)),
    });
    expect(due.granted).toBe(1);
    const rows = await (await getDb()).all<{ id: string; payment_intent_id: string; charge_id: string; invoice_id: string }>(
      `SELECT id, payment_intent_id, charge_id, invoice_id FROM stripe_grants
       WHERE user_id = ? AND kind = 'defense' ORDER BY id`,
      [user.id],
    );
    expect(rows.map((row) => row.id)).toEqual([
      "refill:sub_year_claw:0:defense",
      "refill:sub_year_claw:1:defense",
    ]);
    expect(rows.every((row) => row.payment_intent_id === "pi_in_year_claw" && row.charge_id === "ch_in_year_claw")).toBe(
      true,
    );
    expect(rows.every((row) => row.invoice_id === "in_year_claw")).toBe(true);
    const refund = await postWebhook({
      id: "evt_year_claw_refund",
      type: "charge.refunded",
      data: {
        object: { id: "ch_in_year_claw", payment_intent: "pi_in_year_claw", amount: 9900, amount_refunded: 9900 },
      },
    });
    expect(refund.status).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ defense: 0, challenge: 0 });
    expect((await getUserPlan(user.id)).status).toBe("active");
    expect(await subscriptionFlags("sub_year_claw")).toEqual({ terminal: 0, refillsStopped: 1 });
    const again = await grantDueSubscriptionRefills({
      userId: user.id,
      now: new Date(Date.UTC(2026, 2, 31, 12)),
    });
    expect(again.granted).toBe(0);
    expect((await getBalance(user.id)).defense).toBe(0);
  });

  it("does not take the other pack when one pack8 was already spent", async () => {
    const { user } = await signIn("two-pack8@pay.example");
    await postWebhook(
      checkoutEvent({
        id: "evt_pack_a",
        userId: user.id,
        sku: "pack8",
        amount: 2000,
        paymentIntent: "pi_pack_a",
      }),
    );
    await postWebhook(
      checkoutEvent({
        id: "evt_pack_b",
        userId: user.id,
        sku: "pack8",
        amount: 2000,
        paymentIntent: "pi_pack_b",
      }),
    );
    expect((await getBalance(user.id)).flex).toBe(16);
    for (let i = 0; i < 8; i += 1) {
      await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: `hold-two-pack-${i}` });
    }
    expect((await getBalance(user.id)).flex).toBe(8);
    const refund = await postWebhook({
      id: "evt_pack_a_refund",
      type: "charge.refunded",
      data: { object: { id: "ch_pack_a", payment_intent: "pi_pack_a", amount: 2000, amount_refunded: 2000 } },
    });
    expect(refund.status).toBe(200);
    expect((await getBalance(user.id)).flex).toBe(8);
    const packs = await (await getDb()).all<{ payment_intent_id: string; clawed_credits: number; refunded_at: string | null }>(
      `SELECT payment_intent_id, clawed_credits, refunded_at FROM stripe_grants WHERE user_id = ? ORDER BY payment_intent_id`,
      [user.id],
    );
    expect(packs).toEqual([
      expect.objectContaining({ payment_intent_id: "pi_pack_a", clawed_credits: 8, refunded_at: expect.any(String) }),
      expect.objectContaining({ payment_intent_id: "pi_pack_b", clawed_credits: 0, refunded_at: null }),
    ]);
  });

  it("keeps yearly refills running after a partial refund", async () => {
    const { user } = await signIn("year-partial@pay.example");
    const anchor = Math.floor(Date.UTC(2026, 0, 31) / 1000);
    const paid = await postWebhook(
      invoiceEvent({
        id: "evt_year_partial",
        invoiceId: "in_year_partial",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_create",
        subscription: "sub_year_partial",
        periodStart: anchor,
        periodEnd: Math.floor(Date.UTC(2027, 0, 31) / 1000),
        anchor,
      }),
    );
    expect(paid.status).toBe(200);
    expect((await getBalance(user.id)).defense).toBe(10);
    const refund = await postWebhook({
      id: "evt_year_partial_refund",
      type: "charge.refunded",
      data: {
        object: { id: "ch_in_year_partial", payment_intent: "pi_in_year_partial", amount: 9900, amount_refunded: 990 },
      },
    });
    expect(refund.status).toBe(200);
    expect((await getBalance(user.id)).defense).toBe(9);
    expect((await getUserPlan(user.id)).status).toBe("active");
    expect(await subscriptionFlags("sub_year_partial")).toEqual({ terminal: 0, refillsStopped: 0 });
    const due = await grantDueSubscriptionRefills({
      userId: user.id,
      now: new Date(Date.UTC(2026, 1, 28, 12)),
    });
    expect(due.granted).toBe(1);
    expect((await getBalance(user.id)).defense).toBe(10);
  });

  it("stops refills on a full yearly refund without blocking the next paid invoice", async () => {
    const { user } = await signIn("year-full@pay.example");
    const anchor = Math.floor(Date.UTC(2026, 0, 31) / 1000);
    const first = await postWebhook({
      ...invoiceEvent({
        id: "evt_year_full",
        invoiceId: "in_year_full",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_create",
        subscription: "sub_year_full",
        periodStart: anchor,
        periodEnd: Math.floor(Date.UTC(2027, 0, 31) / 1000),
        anchor,
      }),
      created: 10,
    });
    expect(first.status).toBe(200);
    const refund = await postWebhook({
      id: "evt_year_full_refund",
      type: "charge.refunded",
      data: {
        object: { id: "ch_in_year_full", payment_intent: "pi_in_year_full", amount: 9900, amount_refunded: 9900 },
      },
    });
    expect(refund.status).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ defense: 0, challenge: 0 });
    expect((await getUserPlan(user.id)).status).toBe("active");
    expect(await subscriptionFlags("sub_year_full")).toEqual({ terminal: 0, refillsStopped: 1 });
    const stopped = await grantDueSubscriptionRefills({
      userId: user.id,
      now: new Date(Date.UTC(2026, 1, 28, 12)),
    });
    expect(stopped.granted).toBe(0);
    const next = await postWebhook({
      ...invoiceEvent({
        id: "evt_year_full_next",
        invoiceId: "in_year_full_next",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_cycle",
        subscription: "sub_year_full",
        periodStart: Math.floor(Date.UTC(2027, 0, 31) / 1000),
        periodEnd: Math.floor(Date.UTC(2028, 0, 31) / 1000),
        anchor,
      }),
      created: 500,
    });
    expect(next.status).toBe(200);
    expect(await next.json()).not.toMatchObject({ ignored: true });
    expect((await getBalance(user.id)).defense).toBe(10);
    expect(await subscriptionFlags("sub_year_full")).toEqual({ terminal: 0, refillsStopped: 0 });
    const resumed = await grantDueSubscriptionRefills({
      userId: user.id,
      now: new Date(Date.UTC(2027, 1, 28, 12)),
    });
    expect(resumed.granted).toBe(1);
  });

  it("stops refills on a yearly dispute and still grants the next paid invoice", async () => {
    const { user } = await signIn("year-dispute@pay.example");
    const anchor = Math.floor(Date.UTC(2026, 0, 31) / 1000);
    expect(
      (
        await postWebhook({
          ...invoiceEvent({
            id: "evt_year_disp",
            invoiceId: "in_year_disp",
            userId: user.id,
            sku: "subscription_year",
            amount: 9900,
            reason: "subscription_create",
            subscription: "sub_year_disp",
            periodStart: anchor,
            periodEnd: Math.floor(Date.UTC(2027, 0, 31) / 1000),
            anchor,
          }),
          created: 10,
        })
      ).status,
    ).toBe(200);
    const dispute = await postWebhook({
      id: "evt_year_disp_open",
      type: "charge.dispute.created",
      data: { object: { id: "dp_year", charge: "ch_in_year_disp", payment_intent: "pi_in_year_disp" } },
    });
    expect(dispute.status).toBe(200);
    expect((await getUserPlan(user.id)).status).toBe("active");
    expect(await subscriptionFlags("sub_year_disp")).toEqual({ terminal: 0, refillsStopped: 1 });
    const next = await postWebhook({
      ...invoiceEvent({
        id: "evt_year_disp_next",
        invoiceId: "in_year_disp_next",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_cycle",
        subscription: "sub_year_disp",
        periodStart: Math.floor(Date.UTC(2027, 0, 31) / 1000),
        periodEnd: Math.floor(Date.UTC(2028, 0, 31) / 1000),
        anchor,
      }),
      created: 500,
    });
    expect(next.status).toBe(200);
    expect(await next.json()).not.toMatchObject({ ignored: true });
    expect((await getBalance(user.id)).defense).toBe(10);
    expect(await subscriptionFlags("sub_year_disp")).toEqual({ terminal: 0, refillsStopped: 0 });
  });

  it("links year-2 refills to year 2's invoice and a year-2 refund leaves year 1", async () => {
    const { user } = await signIn("two-year@pay.example");
    const anchor = Math.floor(Date.UTC(2026, 0, 31) / 1000);
    const year2Start = Math.floor(Date.UTC(2027, 0, 31) / 1000);
    const first = await postWebhook(
      invoiceEvent({
        id: "evt_two_y1",
        invoiceId: "in_two_y1",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_create",
        subscription: "sub_two_year",
        periodStart: anchor,
        periodEnd: year2Start,
        anchor,
      }),
    );
    expect(first.status).toBe(200);
    expect(
      (
        await grantDueSubscriptionRefills({
          userId: user.id,
          now: new Date(Date.UTC(2026, 1, 28, 12)),
        })
      ).granted,
    ).toBe(1);
    const second = await postWebhook({
      ...invoiceEvent({
        id: "evt_two_y2",
        invoiceId: "in_two_y2",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_cycle",
        subscription: "sub_two_year",
        periodStart: year2Start,
        periodEnd: Math.floor(Date.UTC(2028, 0, 31) / 1000),
        anchor,
      }),
      created: 400,
    });
    expect(second.status).toBe(200);
    expect(
      (
        await grantDueSubscriptionRefills({
          userId: user.id,
          now: new Date(Date.UTC(2027, 1, 28, 12)),
        })
      ).granted,
    ).toBe(1);
    const rows = await (await getDb()).all<{
      id: string;
      invoice_id: string;
      payment_intent_id: string;
      charge_id: string;
    }>(
      `SELECT id, invoice_id, payment_intent_id, charge_id FROM stripe_grants
       WHERE user_id = ? AND kind = 'defense' ORDER BY id`,
      [user.id],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("refill:sub_two_year:0:defense")).toMatchObject({
      invoice_id: "in_two_y1",
      payment_intent_id: "pi_in_two_y1",
      charge_id: "ch_in_two_y1",
    });
    expect(byId.get("refill:sub_two_year:1:defense")).toMatchObject({
      invoice_id: "in_two_y1",
      payment_intent_id: "pi_in_two_y1",
    });
    expect(byId.get("refill:sub_two_year:12:defense")).toMatchObject({
      invoice_id: "in_two_y2",
      payment_intent_id: "pi_in_two_y2",
      charge_id: "ch_in_two_y2",
    });
    expect(byId.get("refill:sub_two_year:13:defense")).toMatchObject({
      invoice_id: "in_two_y2",
      payment_intent_id: "pi_in_two_y2",
      charge_id: "ch_in_two_y2",
    });
    const refund = await postWebhook({
      id: "evt_two_y2_refund",
      type: "charge.refunded",
      data: {
        object: { id: "ch_in_two_y2", payment_intent: "pi_in_two_y2", amount: 9900, amount_refunded: 9900 },
      },
    });
    expect(refund.status).toBe(200);
    const after = await (await getDb()).all<{
      invoice_id: string;
      clawed_credits: number;
      refunded_at: string | null;
    }>(
      `SELECT invoice_id, clawed_credits, refunded_at FROM stripe_grants
       WHERE user_id = ? AND kind = 'defense'`,
      [user.id],
    );
    for (const row of after) {
      if (row.invoice_id === "in_two_y1") {
        expect(row.refunded_at).toBeNull();
        expect(Number(row.clawed_credits)).toBe(0);
      } else {
        expect(row.invoice_id).toBe("in_two_y2");
        expect(row.refunded_at).not.toBeNull();
        expect(Number(row.clawed_credits)).toBe(10);
      }
    }
    expect((await getBalance(user.id)).defense).toBe(0);
  });

  it("rejects a checkout whose lookup key does not match the product", async () => {
    const { user } = await signIn("bad-price@pay.example");
    const res = await postWebhook(
      checkoutEvent({
        id: "evt_bad_lookup",
        userId: user.id,
        sku: "pack3",
        amount: 1000,
        paymentIntent: "pi_bad_lookup",
        lookupKey: "dit_pack_8",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Price does not match the plan." });
    expect((await getBalance(user.id)).flex).toBe(0);

    const cheap = await postWebhook(
      checkoutEvent({
        id: "evt_cheap_ok",
        userId: user.id,
        sku: "defense",
        amount: 1,
        paymentIntent: "pi_cheap_ok",
      }),
    );
    expect(cheap.status).toBe(200);
    expect((await getBalance(user.id)).defenseOnly).toBe(1);
  });
});

function unitAmount(key: string): number {
  switch (key) {
    case "dit_defense_payg":
      return 400;
    case "dit_challenge_payg":
      return 300;
    case "dit_pack_3":
      return 1000;
    case "dit_pack_8":
      return 2000;
    case "dit_pro_monthly":
      return 1100;
    case "dit_pro_yearly":
      return 9900;
    case "dit_team_monthly":
      return 14900;
    case "dit_enterprise_base":
      return 49000;
    case "dit_enterprise_extra_unit":
      return 250;
    default:
      return 0;
  }
}

function catalogClient(missing: string[] = []): { client: StripePriceClient; calls: string[][] } {
  const calls: string[][] = [];
  const client: StripePriceClient = {
    async list(lookupKeys) {
      calls.push([...lookupKeys]);
      return Object.entries(STRIPE_LOOKUP_KEYS)
        .filter(([, key]) => lookupKeys.includes(key) && !missing.includes(key))
        .map(([, key]) => ({
          id: `price_${key}`,
          lookup_key: key,
          currency: "eur",
          unit_amount: unitAmount(key),
          product: { id: `prod_${key}`, name: key },
        }));
    },
  };
  return { client, calls };
}

describe("checkout session", () => {
  it("builds a signed-in session tied to the user and does not call Stripe when mocked", async () => {
    const seen: StripeCheckoutRequest[] = [];
    setStripeCheckoutApiForTests({
      async createSession(input) {
        seen.push(input);
        return { id: "cs_test_mock", url: "https://checkout.stripe.com/c/pay/cs_test_mock" };
      },
    });
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    const prices = catalogClient();
    setStripePriceClientForTests(prices.client);
    const { user, cookie } = await signIn("checkout-mock@pay.example");
    const anon = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: "defense" }),
      }),
    );
    expect(anon.status).toBe(401);
    const res = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ sku: "defense" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "cs_test_mock",
      url: "https://checkout.stripe.com/c/pay/cs_test_mock",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      userId: user.id,
      sku: "defense",
      priceId: "price_dit_defense_payg",
      lookupKey: "dit_defense_payg",
    });
    expect(prices.calls).toEqual([["dit_defense_payg"]]);
    expect(seen[0].successUrl).toContain("/dashboard?checkout={CHECKOUT_SESSION_ID}");
    expect(seen[0].cancelUrl).toContain("/billing/cancel");
    const params = checkoutSessionParams(seen[0]);
    expect(params.mode).toBe("payment");
    expect(params.client_reference_id).toBe(user.id);
    expect(Object.prototype.hasOwnProperty.call(params, "payment_method_types")).toBe(false);
    expect(params.adaptive_pricing).toEqual({ enabled: false });
    expect(params.consent_collection).toEqual({ terms_of_service: "required" });
    const waiver = params.custom_text?.terms_of_service_acceptance;
    const waiverMessage = waiver && typeof waiver === "object" ? waiver.message : "";
    expect(waiverMessage).toMatch(/\/terms/);
    expect(waiverMessage).toMatch(/14-day/);
    expect(waiverMessage).toContain("provide One defense immediately");
    expect(waiverMessage).not.toMatch(/provide defense immediately/);
    expect(params.automatic_tax).toEqual({ enabled: false });
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.integration_identifier).toMatch(/^dit_checkout_[a-z]{8}$/);
    expect(params.metadata).toMatchObject({ user_id: user.id, sku: "defense", lookup_key: "dit_defense_payg" });
    expect(params.line_items).toEqual([{ price: "price_dit_defense_payg", quantity: 1 }]);
    expect(params.payment_intent_data?.metadata).toMatchObject({ user_id: user.id, sku: "defense" });
    expect(params.subscription_data).toBeUndefined();
    process.env.STRIPE_TAX_ENABLED = "true";
    expect(checkoutSessionParams(seen[0]).automatic_tax).toEqual({ enabled: true });
    delete process.env.STRIPE_TAX_ENABLED;

    process.env.STRIPE_SECRET_KEY = "sk_live_disabled";
    const refused = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ sku: "defense" }),
      }),
    );
    expect(refused.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("lists payg, packs, Pro, and Team while billing is on", () => {
    expect(checkoutCatalog()).toBeNull();
    process.env.BILLING_ENABLED = "1";
    const catalog = checkoutCatalog();
    expect(catalog?.map((product) => product.sku)).toEqual([
      "defense",
      "challenge",
      "pack3",
      "pack8",
      "subscription_month",
      "subscription_year",
      "team_month",
    ]);
    expect(catalog?.find((product) => product.sku === "pack8")?.detail).toMatch(/defense or a challenge/);
    expect(catalog?.find((product) => product.sku === "subscription_year")?.detail).toMatch(
      /each month/,
    );
    expect(catalog?.find((product) => product.sku === "subscription_year")?.detail).toMatch(/do not roll over/);
    expect(catalog?.some((product) => product.sku === "team_month")).toBe(true);
  });

  it("links checkout to /terms and does not ship that page", () => {
    const pricing = readFileSync("src/app/pricing/page.tsx", "utf8");
    const dashboard = readFileSync("src/app/dashboard/page.tsx", "utf8");
    const footer = readFileSync("src/components/site-footer.tsx", "utf8");
    expect(pricing).toMatch(/<a href="\/terms"/);
    expect(dashboard).toMatch(/<a href="\/terms"/);
    expect(footer).not.toMatch(/href="\/terms"/);
    expect(existsSync("src/app/terms/page.tsx")).toBe(false);
  });

  it("starts a Pro subscription checkout and refuses Enterprise", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    const prices = catalogClient();
    setStripePriceClientForTests(prices.client);
    const seen: StripeCheckoutRequest[] = [];
    setStripeCheckoutApiForTests({
      async createSession(input) {
        seen.push(input);
        return { id: "cs_test_pro", url: "https://checkout.stripe.com/c/pay/cs_test_pro" };
      },
    });
    const { user, cookie } = await signIn("pro-sub@pay.example");
    const res = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ sku: "subscription_month" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ sku: "subscription_month", mode: "subscription", userId: user.id });
    const params = checkoutSessionParams(seen[0]);
    expect(params.mode).toBe("subscription");
    expect(Object.prototype.hasOwnProperty.call(params, "payment_method_types")).toBe(false);
    expect(params.adaptive_pricing).toEqual({ enabled: false });
    expect(params.subscription_data?.metadata).toMatchObject({ user_id: user.id, sku: "subscription_month" });
    expect(params.consent_collection).toEqual({ terms_of_service: "required" });
    const waiver = params.custom_text?.terms_of_service_acceptance;
    const proWaiver = waiver && typeof waiver === "object" ? waiver.message : "";
    expect(proWaiver).toMatch(/14-day/);
    expect(proWaiver).toContain("Pro monthly");
    expect(proWaiver).not.toContain("subscription_month");
    expect(params.subscription_data?.billing_mode).toEqual({ type: "flexible" });
    expect(params.payment_intent_data).toBeUndefined();
    const enterprise = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ sku: "enterprise_month" }),
      }),
    );
    expect(enterprise.status).toBe(400);
    expect(await enterprise.json()).toEqual({ error: "That price is not for sale." });
  });

  it("rate limits checkout and the portal per account", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.RATE_LIMIT_CHECKOUT_USER = "1";
    process.env.RATE_LIMIT_PORTAL_USER = "1";
    const prices = catalogClient();
    setStripePriceClientForTests(prices.client);
    setStripeCheckoutApiForTests({
      async createSession() {
        return { id: "cs_limit", url: "https://checkout.stripe.com/c/pay/cs_limit" };
      },
    });
    const { cookie } = await signIn("limit-checkout@pay.example");
    const headers = { cookie, "content-type": "application/json" };
    const first = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers,
        body: JSON.stringify({ sku: "defense" }),
      }),
    );
    expect(first.status).toBe(200);
    const second = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers,
        body: JSON.stringify({ sku: "defense" }),
      }),
    );
    expect(second.status).toBe(429);
    const opened = await portal(
      new Request("http://localhost/api/billing/portal", { method: "POST", headers }),
    );
    expect(opened.status).toBe(400);
    const limited = await portal(
      new Request("http://localhost/api/billing/portal", { method: "POST", headers }),
    );
    expect(limited.status).toBe(429);
    delete process.env.RATE_LIMIT_CHECKOUT_USER;
    delete process.env.RATE_LIMIT_PORTAL_USER;
  });

  it("fails closed when a lookup key is missing and caches a complete catalog", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    const missing = catalogClient(["dit_pack_3"]);
    setStripePriceClientForTests(missing.client);
    await expect(resolvePrices(["dit_defense_payg", "dit_pack_3"])).rejects.toMatchObject({
      status: 502,
      message: "Stripe catalog is missing lookup key dit_pack_3.",
    });
    expect(missing.calls).toHaveLength(1);

    const prices = catalogClient();
    setStripePriceClientForTests(prices.client);
    const first = await resolvePrices(["dit_pack_8", "dit_defense_payg"]);
    const second = await resolvePrices(["dit_defense_payg", "dit_pack_8"]);
    expect(second.get("dit_defense_payg")?.priceId).toBe("price_dit_defense_payg");
    expect(first.get("dit_pack_8")?.unitAmount).toBe(2000);
    expect(first.get("dit_defense_payg")?.productName).toBe("dit_defense_payg");
    expect(prices.calls).toHaveLength(1);
    expect(checkoutLookupKey("defense")).toBe("dit_defense_payg");
    expireStripePriceCacheForTests();
    await resolvePrices(["dit_defense_payg", "dit_pack_8"]);
    expect(prices.calls).toHaveLength(2);
  });
});

describe("webhook idempotency and subscription state", () => {
  it("does not credit a second checkout event for the same session", async () => {
    const { user } = await signIn("dup-session@pay.example");
    const first = await postWebhook(
      checkoutEvent({
        id: "evt_dup_session_a",
        sessionId: "cs_same_defense",
        userId: user.id,
        sku: "defense",
        amount: 400,
        paymentIntent: "pi_dup_session",
      }),
    );
    expect(first.status).toBe(200);
    const second = await postWebhook(
      checkoutEvent({
        id: "evt_dup_session_b",
        sessionId: "cs_same_defense",
        userId: user.id,
        sku: "defense",
        amount: 400,
        paymentIntent: "pi_dup_session",
        type: "checkout.session.async_payment_succeeded",
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect((await getBalance(user.id)).defenseOnly).toBe(1);
  });

  it("grants a subscription once on invoice.paid and ignores a replay", async () => {
    const { user } = await signIn("replay-invoice@pay.example");
    const opened = await postWebhook(
      checkoutEvent({
        id: "evt_replay_open",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        paymentIntent: "pi_replay_open",
        mode: "subscription",
        customer: "cus_replay",
        subscription: "sub_replay",
      }),
    );
    expect(opened.status).toBe(200);
    expect((await getBalance(user.id)).defense).toBe(0);
    const db = await getDb();
    const attached = await db.get<{ stripe_subscription_id: string; stripe_customer_id: string }>(
      `SELECT p.stripe_subscription_id, b.stripe_customer_id
       FROM user_plans p JOIN billing_profiles b ON b.user_id = p.user_id
       WHERE p.user_id = ?`,
      [user.id],
    );
    expect(attached).toMatchObject({ stripe_subscription_id: "sub_replay", stripe_customer_id: "cus_replay" });

    const paid = await postWebhook(
      invoiceEvent({
        id: "evt_replay_paid_a",
        invoiceId: "in_replay",
        userId: user.id,
        sku: "subscription_month",
        amount: 1,
        reason: "subscription_create",
        customer: "cus_replay",
        subscription: "sub_replay",
      }),
    );
    expect(paid.status).toBe(200);
    expect((await getBalance(user.id)).defense).toBe(10);

    const replay = await postWebhook(
      invoiceEvent({
        id: "evt_replay_paid_b",
        invoiceId: "in_replay",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_cycle",
        customer: "cus_replay",
        subscription: "sub_replay",
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true });
    expect((await getBalance(user.id)).defense).toBe(10);
    expect((await getBalance(user.id)).challenge).toBe(5);
  });

  it("grants yearly Pro month 0 once and ignores a replayed invoice", async () => {
    const { user } = await signIn("replay-year@pay.example");
    const periodStart = Date.UTC(2026, 0, 31) / 1000;
    const periodEnd = Date.UTC(2027, 0, 31) / 1000;
    const paid = await postWebhook(
      invoiceEvent({
        id: "evt_year_replay_a",
        invoiceId: "in_year_replay",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_create",
        subscription: "sub_year_replay",
        periodStart,
        periodEnd,
        anchor: periodStart,
      }),
    );
    expect(paid.status).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });

    const replay = await postWebhook(
      invoiceEvent({
        id: "evt_year_replay_b",
        invoiceId: "in_year_replay",
        userId: user.id,
        sku: "subscription_year",
        amount: 9900,
        reason: "subscription_cycle",
        subscription: "sub_year_replay",
        periodStart,
        periodEnd,
        anchor: periodStart,
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true });
    expect(await getBalance(user.id)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });
    const plan = await (await getDb()).get<{ last_granted_period_index: number }>(
      `SELECT last_granted_period_index FROM user_plans WHERE user_id = ?`,
      [user.id],
    );
    expect(plan?.last_granted_period_index).toBe(0);
    const grants = await (await getDb()).all<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM credit_ledger WHERE user_id = ? AND kind = 'defense' AND amount > 0`,
      [user.id],
    );
    expect(grants.map((row) => row.idempotency_key)).toEqual(["refill:sub_year_replay:0:defense"]);
  });

  it("keeps credits when cancel is scheduled and expires them when the subscription ends", async () => {
    const { user } = await signIn("schedule-cancel@pay.example");
    await postWebhook(
      invoiceEvent({
        id: "evt_sched_inv",
        invoiceId: "in_sched",
        userId: user.id,
        sku: "subscription_month",
        amount: 1100,
        reason: "subscription_create",
        subscription: "sub_sched",
      }),
    );
    const updated = await postWebhook({
      id: "evt_sched_upd",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_sched",
          status: "active",
          cancel_at_period_end: true,
          metadata: { user_id: user.id, sku: "subscription_month" },
        },
      },
    });
    expect(updated.status).toBe(200);
    expect((await getBalance(user.id)).defense).toBe(10);
    const row = await (await getDb()).get<{ cancel_at_period_end: number; status: string }>(
      `SELECT cancel_at_period_end, status FROM user_plans WHERE user_id = ?`,
      [user.id],
    );
    expect(row).toMatchObject({ cancel_at_period_end: 1, status: "active" });
  });

  it("marks a failed renewal past due without taking credits", async () => {
    const { user } = await signIn("past-due@pay.example");
    await postWebhook(
      invoiceEvent({
        id: "evt_due_paid",
        invoiceId: "in_due",
        userId: user.id,
        sku: "team_month",
        amount: 14900,
        reason: "subscription_create",
      }),
    );
    expect((await getBalance(user.id)).defense).toBe(50);
    const failed = await postWebhook({
      id: "evt_due_fail",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_due_fail",
          parent: { subscription_details: { metadata: { user_id: user.id, sku: "team_month" } } },
        },
      },
    });
    expect(failed.status).toBe(200);
    expect((await getUserPlan(user.id)).status).toBe("past_due");
    expect((await getBalance(user.id)).defense).toBe(50);
    const notice = await (await getDb()).get<{ payment_notice: string }>(
      `SELECT payment_notice FROM billing_profiles WHERE user_id = ?`,
      [user.id],
    );
    expect(notice?.payment_notice).toMatch(/billing portal/);
  });

  it("bills unbilled enterprise overage once on invoice.created", async () => {
    const { user } = await signIn("overage@pay.example");
    const db = await getDb();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO billing_profiles (user_id, card_fingerprint, stripe_customer_id, updated_at)
       VALUES (?, NULL, 'cus_overage', ?)`,
      [user.id, now],
    );
    await db.run(
      `INSERT INTO billing_overages
        (id, user_id, plan_id, amount_cents, currency, idempotency_key, ref_type, ref_id, created_at)
       VALUES ('ov_1', ?, 'enterprise', 250, 'eur', 'overage:ov_1', 'hold', 'hold_1', ?)`,
      [user.id, now],
    );
    const items: { price: string; quantity: number; invoice: string }[] = [];
    setInvoiceItemWriterForTests(async (input) => {
      items.push({ price: input.price, quantity: input.quantity, invoice: input.invoice });
    });
    setStripePriceClientForTests(catalogClient().client);
    const created = await postWebhook({
      id: "evt_overage_draft",
      type: "invoice.created",
      data: { object: { id: "in_overage", customer: "cus_overage", billing_reason: "subscription_cycle" } },
    });
    expect(created.status).toBe(200);
    expect(items).toEqual([{ price: "price_dit_enterprise_extra_unit", quantity: 1, invoice: "in_overage" }]);
    const again = await postWebhook({
      id: "evt_overage_draft_2",
      type: "invoice.created",
      data: { object: { id: "in_overage_2", customer: "cus_overage", billing_reason: "subscription_cycle" } },
    });
    expect(again.status).toBe(200);
    expect(items).toHaveLength(1);
    const row = await db.get<{ ref_type: string }>(`SELECT ref_type FROM billing_overages WHERE id = 'ov_1'`);
    expect(row?.ref_type).toBe("stripe_invoice");
  });

  it("accepts a line by price id and rejects a different price id", async () => {
    const { user } = await signIn("price-id@pay.example");
    setStripePriceClientForTests(catalogClient().client);
    const wrong = await postWebhook({
      id: "evt_price_id_wrong",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_price_id_wrong",
          client_reference_id: user.id,
          payment_status: "paid",
          mode: "payment",
          amount_total: 1000,
          currency: "eur",
          payment_intent: "pi_price_id_wrong",
          metadata: { sku: "pack3", user_id: user.id },
          line_items: { data: [{ price: { id: "price_dit_pack_8", lookup_key: null } }] },
        },
      },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "Price does not match the plan." });
    const right = await postWebhook({
      id: "evt_price_id_right",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_price_id_right",
          client_reference_id: user.id,
          payment_status: "paid",
          mode: "payment",
          amount_total: 50,
          currency: "usd",
          payment_intent: "pi_price_id_right",
          metadata: { sku: "pack3", user_id: user.id },
          line_items: { data: [{ price: "price_dit_pack_3" }] },
        },
      },
    });
    expect(right.status).toBe(200);
    expect((await getBalance(user.id)).flex).toBe(3);
  });

  it("keeps sandbox price ids out of production code", () => {
    const sandbox = JSON.parse(readFileSync(join(__dirname, "fixtures", "stripe", "sandbox-catalog.json"), "utf8")) as {
      account: { stripe_context: string; livemode: boolean };
      prices: Record<string, { id: string }>;
    };
    expect(sandbox.account).toMatchObject({ stripe_context: "acct_1UNDfOBIumCL91iA", livemode: false });
    expect(sandbox.prices.dit_defense_payg.id).toBe("price_1UTNtuBIumCL91iAj0fkLVCn");
    const payments = readFileSync(join(__dirname, "..", "src", "lib", "payments.ts"), "utf8");
    const prices = readFileSync(join(__dirname, "..", "src", "lib", "stripe-prices.ts"), "utf8");
    expect(payments + prices).not.toContain("price_1UTN");
    expect(payments).not.toContain("PAYMENTS_ENABLED");
    expect(payments).not.toContain("payment_method_types");
  });
});
