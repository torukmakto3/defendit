import { createHmac } from "crypto";
import { mkdtempSync } from "fs";
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
import { checkoutSessionParams, setStripeCheckoutApiForTests, type StripeCheckoutRequest } from "../src/lib/stripe-checkout";
import { assertStripeReady, checkoutCatalog, paymentsEnabled } from "../src/lib/stripe-config";

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
  delete process.env.PAYMENTS_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_ALLOW_LIVE;
  delete process.env.STRIPE_MODE;
});

beforeEach(() => {
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
  delete process.env.PAYMENTS_ENABLED;
  delete process.env.BILLING_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_ALLOW_LIVE;
  delete process.env.STRIPE_MODE;
  delete process.env.STRIPE_PRICE_DEFENSE;
  delete process.env.STRIPE_PRICE_CHALLENGE;
  delete process.env.STRIPE_PRICE_PACK3;
  delete process.env.STRIPE_PRICE_PACK8;
  delete process.env.STRIPE_PRICE_SUBSCRIPTION_MONTH;
  delete process.env.STRIPE_PRICE_SUBSCRIPTION_YEAR;
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
  process.env.PAYMENTS_ENABLED = "true";
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

function checkoutEvent(input: {
  id: string;
  userId: string;
  sku: string;
  amount: number;
  paymentIntent: string;
  mode?: "payment" | "subscription";
  priceId?: string;
}) {
  return {
    id: input.id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${input.id}`,
        client_reference_id: input.userId,
        payment_status: "paid",
        mode: input.mode ?? "payment",
        amount_total: input.amount,
        currency: "eur",
        payment_intent: input.paymentIntent,
        metadata: {
          sku: input.sku,
          user_id: input.userId,
          ...(input.priceId ? { price_id: input.priceId } : {}),
        },
      },
    },
  };
}

function invoiceEvent(input: {
  id: string;
  invoiceId: string;
  userId: string;
  sku: string;
  amount: number;
  reason?: string;
  nested?: boolean;
}) {
  const metadata = { user_id: input.userId, sku: input.sku };
  return {
    id: input.id,
    type: "invoice.paid",
    data: {
      object: {
        id: input.invoiceId,
        amount_paid: input.amount,
        currency: "eur",
        billing_reason: input.reason ?? "subscription_cycle",
        payment_intent: `pi_${input.invoiceId}`,
        charge: `ch_${input.invoiceId}`,
        metadata: input.nested ? {} : metadata,
        parent: input.nested ? { subscription_details: { metadata } } : undefined,
      },
    },
  };
}

describe("payments flags", () => {
  it("keeps the beta grant and budget when checkout is off", async () => {
    expect(paymentsEnabled()).toBe(false);
    expect(billingEnabled()).toBe(false);
    expect(betaBudgetCents()).toBe(15000);
    expect(checkoutCatalog()).toBeNull();
    const { user } = await signIn("beta-untouched@pay.example");
    await ensureBetaGrant(user.id);
    expect(await getBalance(user.id)).toMatchObject({ defense: 3, challenge: 2, learnSlots: 3 });
    process.env.PAYMENTS_ENABLED = "true";
    expect(billingEnabled()).toBe(false);
    process.env.BILLING_ENABLED = "true";
    delete process.env.PAYMENTS_ENABLED;
    expect(paymentsEnabled()).toBe(false);
    expect(billingEnabled()).toBe(true);
  });

  it("refuses to start when payments are on with a live key", () => {
    process.env.PAYMENTS_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_live_disabled";
    expect(() => assertStripeReady()).toThrow(/live Stripe/i);
    expect(() => registerNode()).toThrow(/live Stripe/i);
    process.env.STRIPE_ALLOW_LIVE = "true";
    expect(() => registerNode()).not.toThrow();
    delete process.env.STRIPE_ALLOW_LIVE;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_MODE = "live";
    expect(() => assertStripeReady()).toThrow(/live Stripe/i);
    delete process.env.PAYMENTS_ENABLED;
    process.env.STRIPE_SECRET_KEY = "sk_live_disabled";
    expect(() => assertStripeReady()).not.toThrow();
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
        nested: true,
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
    expect(await getBalance(year.user.id)).toMatchObject({ defense: 120, challenge: 60, learnSlots: 10 });
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
    expect((await getUserPlan(user.id)).status).toBe("canceled");
    expect(await getBalance(user.id)).toMatchObject({ defense: 10, challenge: 5 });
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

  it("rejects a checkout whose price id does not match the configured price", async () => {
    process.env.STRIPE_PRICE_PACK3 = "price_pack3_expected";
    const { user } = await signIn("bad-price@pay.example");
    const res = await postWebhook(
      checkoutEvent({
        id: "evt_bad_price_id",
        userId: user.id,
        sku: "pack3",
        amount: 1000,
        paymentIntent: "pi_bad_price_id",
        priceId: "price_pack3_other",
      }),
    );
    expect(res.status).toBe(400);
    expect((await getBalance(user.id)).flex).toBe(0);
  });
});

describe("checkout session", () => {
  it("builds a signed-in session tied to the user and does not call Stripe when mocked", async () => {
    const seen: StripeCheckoutRequest[] = [];
    setStripeCheckoutApiForTests({
      async createSession(input) {
        seen.push(input);
        return { id: "cs_test_mock", url: "https://checkout.stripe.com/c/pay/cs_test_mock" };
      },
    });
    process.env.PAYMENTS_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_PRICE_DEFENSE = "price_defense_test";
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
      priceId: "price_defense_test",
      mode: "payment",
    });
    expect(seen[0].successUrl).toContain("/billing/success?session_id={CHECKOUT_SESSION_ID}");
    expect(seen[0].cancelUrl).toContain("/billing/cancel");
    const params = checkoutSessionParams(seen[0]);
    expect(params.client_reference_id).toBe(user.id);
    expect(params.metadata).toMatchObject({ user_id: user.id, sku: "defense", price_id: "price_defense_test" });
    expect(params.payment_intent_data?.metadata).toMatchObject({ user_id: user.id, sku: "defense" });
    expect(params.subscription_data).toBeUndefined();
    const sub = checkoutSessionParams({ ...seen[0], mode: "subscription", sku: "subscription_month" });
    expect(sub.subscription_data?.metadata).toMatchObject({ user_id: user.id, sku: "subscription_month" });
    expect(sub.payment_intent_data).toBeUndefined();

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

  it("lists the six consumer products only while payments are on", () => {
    expect(checkoutCatalog()).toBeNull();
    process.env.PAYMENTS_ENABLED = "1";
    const catalog = checkoutCatalog();
    expect(catalog?.map((product) => product.sku)).toEqual([
      "defense",
      "challenge",
      "pack3",
      "pack8",
      "subscription_month",
      "subscription_year",
    ]);
    expect(catalog?.find((product) => product.sku === "pack8")?.detail).toMatch(/defense or a challenge/);
    expect(catalog?.find((product) => product.sku === "subscription_month")?.detail).toMatch(/don't roll over/);
  });
});
