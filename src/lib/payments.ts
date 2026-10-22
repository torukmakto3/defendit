/**
 * Stripe Checkout in test mode, writing the credit ledger from verified
 * webhooks. `createCheckout` is the only call that can reach Stripe, and
 * only after `PAYMENTS_ENABLED` is on and the key is not a refused live key.
 *
 * `BILLING_ENABLED` stays the wallet gate. This module does not change the
 * beta grant or the €150 budget. See docs/payments.md.
 */

import { z } from "zod";
import { appUrl } from "./config";
import {
  cancelPlan,
  clawbackCredits,
  grantCredits,
  renewPlan,
  setCardFingerprint,
  type CreditSource,
  type LedgerKind,
} from "./credits";
import { getDb, type Db } from "./db";
import { HttpError } from "./errors";
import {
  billingEnabled,
  isSku,
  PACKS,
  planForSku,
  skuPriceCents,
  type Sku,
} from "./plans";
import { stripeCheckoutApi } from "./stripe-checkout";
import {
  assertSkuForSale,
  isCheckoutSku,
  liveStripeRefused,
  paymentsEnabled,
  stripeSecretKey,
} from "./stripe-config";
import { checkoutLookupKey, resolveCheckoutPrice } from "./stripe-prices";

export { billingEnabled, paymentsEnabled };

export interface BillingResult {
  duplicate: boolean;
  ignored?: boolean;
  unmatched?: boolean;
}

interface GrantSpec {
  kind: LedgerKind;
  source: CreditSource;
  credits: number;
}

const metaSchema = z
  .object({
    sku: z.string().optional(),
    user_id: z.string().optional(),
    lookup_key: z.string().optional(),
  })
  .nullish();

const idOrObject = z.union([z.string(), z.object({ id: z.string() })]).nullish();

const checkoutEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("checkout.session.completed"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      client_reference_id: z.string().min(1).nullish(),
      payment_status: z.string(),
      amount_total: z.number().int().nullish(),
      currency: z.string().nullish(),
      mode: z.enum(["payment", "subscription", "setup"]).optional(),
      customer: z.string().nullish(),
      payment_intent: idOrObject,
      subscription: z.string().nullish(),
      metadata: metaSchema,
    }),
  }),
});

const invoiceEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("invoice.paid"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      amount_paid: z.number().int(),
      currency: z.string(),
      billing_reason: z.string().nullish(),
      charge: idOrObject,
      payment_intent: idOrObject,
      customer: idOrObject,
      metadata: metaSchema,
      subscription_details: z.object({ metadata: metaSchema }).nullish(),
      parent: z
        .object({
          subscription_details: z
            .object({
              metadata: metaSchema,
              subscription: z.string().nullish(),
            })
            .nullish(),
        })
        .nullish(),
    }),
  }),
});

const refundEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("charge.refunded"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      payment_intent: z.string().nullish(),
      amount_refunded: z.number().int().optional(),
    }),
  }),
});

const chargeEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("charge.succeeded"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      payment_intent: z.string().nullish(),
      customer: z.string().nullish(),
      metadata: metaSchema,
      payment_method_details: z
        .object({
          card: z.object({ fingerprint: z.string().optional() }).nullish(),
        })
        .nullish(),
    }),
  }),
});

const subscriptionEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["customer.subscription.deleted", "customer.subscription.updated"]),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      status: z.string(),
      customer: z.string().nullish(),
      metadata: metaSchema,
    }),
  }),
});

type Handled =
  | "checkout.session.completed"
  | "invoice.paid"
  | "charge.refunded"
  | "charge.succeeded"
  | "customer.subscription.deleted"
  | "customer.subscription.updated";

function isHandled(type: string): type is Handled {
  switch (type) {
    case "checkout.session.completed":
    case "invoice.paid":
    case "charge.refunded":
    case "charge.succeeded":
    case "customer.subscription.deleted":
    case "customer.subscription.updated":
      return true;
    default:
      return false;
  }
}

/**
 * Signed-in checkout. Returns the Stripe-hosted URL. Does not grant credits;
 * the webhook does that after the signature check.
 */
export async function createCheckout(input: {
  userId: string;
  email?: string | null;
  sku: Sku;
}): Promise<{ id: string; url: string }> {
  if (!input.userId) throw new HttpError(400, "Checkout is missing an account.");
  if (!paymentsEnabled()) throw new HttpError(404, "Not found");
  if (liveStripeRefused()) throw new HttpError(403, "Live Stripe keys are refused.");
  const sku = assertSkuForSale(input.sku);
  if (!stripeSecretKey()) throw new HttpError(501, "Stripe is not configured");
  const price = await resolveCheckoutPrice(sku);
  if (price.currency.toLowerCase() !== "eur" || price.unitAmount !== skuPriceCents(sku)) {
    throw new HttpError(502, `Stripe price for ${price.lookupKey} does not match the plan.`);
  }
  const session = await stripeCheckoutApi().createSession({
    userId: input.userId,
    email: input.email ?? null,
    sku,
    priceId: price.priceId,
    lookupKey: price.lookupKey,
    successUrl: `${appUrl("/billing/success")}?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: appUrl("/billing/cancel"),
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL.");
  return { id: session.id, url: session.url };
}

export async function simulatePurchase(input: {
  userId: string;
  sku: Sku;
  idempotencyKey: string;
}): Promise<void> {
  if (planForSku(input.sku)) throw new HttpError(400, "Use a renewal for this plan.");
  await applyCreditSku(input.userId, input.sku, input.idempotencyKey);
}

export async function simulateRenewal(input: {
  userId: string;
  sku: Sku;
  idempotencyKey: string;
}): Promise<void> {
  const plan = planForSku(input.sku);
  if (!plan) throw new HttpError(400, "That price is not a subscription.");
  await renewPlan({
    userId: input.userId,
    planId: plan.planId,
    interval: plan.interval,
    periodId: input.idempotencyKey,
  });
}

/**
 * Apply a verified webhook. Callers must check the signature first.
 * Unknown event types are ignored so Stripe does not retry them.
 * A repeated event id credits the ledger once.
 */
export async function applyBillingEvent(event: unknown): Promise<BillingResult> {
  const envelope = z
    .object({
      id: z.string().min(1).max(200),
      type: z.string().min(1).max(120),
    })
    .safeParse(event);
  if (!envelope.success) throw new HttpError(400, "Invalid billing event.");
  const type = envelope.data.type;
  if (!isHandled(type)) return { duplicate: false, ignored: true };
  if (await eventSeen(envelope.data.id)) return { duplicate: true };
  switch (type) {
    case "checkout.session.completed":
      return applyCheckout(checkoutEventSchema.parse(event));
    case "invoice.paid":
      return applyInvoice(invoiceEventSchema.parse(event));
    case "charge.refunded":
      return applyRefund(refundEventSchema.parse(event));
    case "charge.succeeded":
      return applyCharge(chargeEventSchema.parse(event));
    case "customer.subscription.deleted":
    case "customer.subscription.updated":
      return applySubscription(subscriptionEventSchema.parse(event));
    default: {
      const unknown: never = type;
      throw new HttpError(400, `Unhandled billing event: ${String(unknown)}`);
    }
  }
}

async function applyCheckout(event: z.infer<typeof checkoutEventSchema>): Promise<BillingResult> {
  const session = event.data.object;
  if (session.payment_status !== "paid") {
    await logEvent(event.id, event.type);
    return { duplicate: false, ignored: true };
  }
  const skuRaw = session.metadata?.sku;
  if (!skuRaw || !isSku(skuRaw)) throw new HttpError(400, "Checkout is missing a price.");
  const sku = skuRaw;
  assertLookupKey(sku, session.metadata?.lookup_key);
  if (session.currency == null || session.amount_total == null) {
    throw new HttpError(400, "Checkout is missing a price.");
  }
  assertPrice(session.currency, session.amount_total, sku);
  const userId = accountId(session.client_reference_id, session.metadata?.user_id);
  await requireUser(userId);
  await rememberCustomer(userId, session.customer ?? null);
  const paymentIntentId = stripeId(session.payment_intent);
  if (session.mode === "subscription") {
    await logEvent(event.id, event.type);
    return { duplicate: false };
  }
  const plan = planForSku(sku);
  if (plan && session.mode === "payment") throw new HttpError(400, "Subscription checkout has the wrong mode.");
  if (plan) {
    const periodId = `stripe:${event.id}`;
    await renewPlan({ userId, planId: plan.planId, interval: plan.interval, periodId });
    await rememberGrants({
      userId,
      eventId: event.id,
      sku,
      grants: await grantsFromRenewal(userId, periodId),
      grantKey: periodId,
      checkoutSessionId: session.id,
      paymentIntentId,
    });
  } else {
    const grants = await applyCreditSku(userId, sku, `stripe:${event.id}`);
    await rememberGrants({
      userId,
      eventId: event.id,
      sku,
      grants,
      grantKey: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
    });
  }
  return logEvent(event.id, event.type);
}

async function applyInvoice(event: z.infer<typeof invoiceEventSchema>): Promise<BillingResult> {
  const invoice = event.data.object;
  const reason = invoice.billing_reason ?? "";
  if (reason && reason !== "subscription_create" && reason !== "subscription_cycle") {
    await logEvent(event.id, event.type);
    return { duplicate: false, ignored: true };
  }
  const resolved = resolveInvoiceIdentity(invoice);
  if (!isSku(resolved.sku)) throw new HttpError(400, "Invoice is missing a price.");
  const sku = resolved.sku;
  const plan = planForSku(sku);
  if (!plan) throw new HttpError(400, "Invoice is not a subscription.");
  assertPrice(invoice.currency, invoice.amount_paid, sku);
  await requireUser(resolved.userId);
  await rememberCustomer(resolved.userId, stripeId(invoice.customer));
  const periodId = `invoice:${invoice.id}`;
  await renewPlan({
    userId: resolved.userId,
    planId: plan.planId,
    interval: plan.interval,
    periodId,
  });
  await rememberGrants({
    userId: resolved.userId,
    eventId: event.id,
    sku,
    grants: await grantsFromRenewal(resolved.userId, periodId),
    grantKey: periodId,
    invoiceId: invoice.id,
    paymentIntentId: stripeId(invoice.payment_intent),
    chargeId: stripeId(invoice.charge),
  });
  return logEvent(event.id, event.type);
}

interface GrantRow {
  id: string;
  user_id: string;
  kind: string;
  source: string;
  credits: number | string;
  refunded_at: string | null;
}

async function applyRefund(event: z.infer<typeof refundEventSchema>): Promise<BillingResult> {
  const charge = event.data.object;
  const chargeId = charge.id;
  const paymentIntentId = charge.payment_intent?.trim() || null;
  const db = await getDb();
  let duplicate = false;
  let unmatched = false;
  await db.transaction(async (tx) => {
    const inserted = await tx.run(
      `INSERT INTO stripe_events (event_id, event_type, created_at) VALUES (?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id, event.type, new Date().toISOString()],
    );
    if (inserted.changes !== 1) {
      duplicate = true;
      return;
    }
    const grants = await tx.all<GrantRow>(
      `SELECT id, user_id, kind, source, credits, refunded_at FROM stripe_grants
       WHERE refunded_at IS NULL
         AND ((? IS NOT NULL AND charge_id = ?) OR (? IS NOT NULL AND payment_intent_id = ?))`,
      [chargeId, chargeId, paymentIntentId, paymentIntentId],
    );
    if (grants.length === 0) {
      unmatched = true;
      return;
    }
    let shortfall = false;
    const now = new Date().toISOString();
    for (const grant of grants) {
      const result = await clawbackCredits({
        userId: grant.user_id,
        kind: grant.kind as LedgerKind,
        source: grant.source as CreditSource,
        amount: Number(grant.credits),
        idempotencyKey: `clawback:${grant.id}`,
        refType: "stripe_refund",
        refId: event.id,
        db: tx,
      });
      if (result.shortfall > 0) shortfall = true;
      await tx.run(`UPDATE stripe_grants SET refunded_at = ? WHERE id = ? AND refunded_at IS NULL`, [
        now,
        grant.id,
      ]);
    }
    if (shortfall) await flagAccount(tx, grants[0].user_id, now);
  });
  return { duplicate, unmatched };
}

async function applyCharge(event: z.infer<typeof chargeEventSchema>): Promise<BillingResult> {
  const charge = event.data.object;
  const fingerprint = charge.payment_method_details?.card?.fingerprint?.trim() ?? "";
  let userId = charge.metadata?.user_id?.trim() || null;
  const db = await getDb();
  if (!userId && charge.payment_intent) {
    const grant = await db.get<{ user_id: string }>(
      `SELECT user_id FROM stripe_grants WHERE payment_intent_id = ? LIMIT 1`,
      [charge.payment_intent],
    );
    userId = grant?.user_id ?? null;
  }
  if (!userId && charge.customer) userId = await userIdForCustomer(charge.customer);
  if (userId && fingerprint) {
    const exists = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
    if (exists) await setCardFingerprint(userId, fingerprint);
  }
  return logEvent(event.id, event.type);
}

async function applySubscription(event: z.infer<typeof subscriptionEventSchema>): Promise<BillingResult> {
  const sub = event.data.object;
  const ended =
    event.type === "customer.subscription.deleted" ||
    sub.status === "canceled" ||
    sub.status === "unpaid" ||
    sub.status === "incomplete_expired";
  if (!ended) {
    await logEvent(event.id, event.type);
    return { duplicate: false, ignored: true };
  }
  const userId = sub.metadata?.user_id?.trim() || (sub.customer ? await userIdForCustomer(sub.customer) : null);
  if (!userId) {
    await logEvent(event.id, event.type);
    return { duplicate: false, unmatched: true };
  }
  await requireUser(userId);
  await cancelPlan(userId);
  return logEvent(event.id, event.type);
}

function resolveInvoiceIdentity(invoice: z.infer<typeof invoiceEventSchema>["data"]["object"]): {
  sku: string;
  userId: string;
} {
  const metas = [invoice.metadata, invoice.subscription_details?.metadata, invoice.parent?.subscription_details?.metadata];
  for (const meta of metas) {
    const sku = meta?.sku?.trim() ?? "";
    const userId = meta?.user_id?.trim() ?? "";
    if (sku && userId) return { sku, userId };
  }
  throw new HttpError(400, "Invoice is missing an account.");
}

function accountId(ref: string | null | undefined, meta: string | undefined): string {
  const fromRef = ref?.trim() || "";
  const fromMeta = meta?.trim() || "";
  if (fromRef && fromMeta && fromRef !== fromMeta) {
    throw new HttpError(400, "Checkout account does not match.");
  }
  const userId = fromRef || fromMeta;
  if (!userId) throw new HttpError(400, "Checkout is missing an account.");
  return userId;
}

function assertLookupKey(sku: Sku, lookupKey: string | undefined): void {
  if (!isCheckoutSku(sku)) return;
  const expected = checkoutLookupKey(sku);
  if (!lookupKey) return;
  if (lookupKey !== expected) throw new HttpError(400, `Stripe lookup key does not match ${expected}.`);
}

function assertPrice(currency: string, amountCents: number, sku: Sku): void {
  if (currency.toLowerCase() !== "eur") throw new HttpError(400, "Price must be in EUR.");
  if (amountCents !== skuPriceCents(sku)) throw new HttpError(400, "Price does not match the plan.");
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && value.id.trim()) return value.id.trim();
  return null;
}

async function requireUser(userId: string): Promise<void> {
  const db = await getDb();
  const row = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
  if (!row) throw new HttpError(404, "Account not found.");
}

async function applyCreditSku(userId: string, sku: Sku, idempotencyKey: string): Promise<GrantSpec[]> {
  switch (sku) {
    case "defense":
      await grantCredits({
        userId,
        kind: "defense",
        amount: 1,
        reason: "purchase",
        source: "purchase",
        idempotencyKey: `${idempotencyKey}:defense`,
      });
      return [{ kind: "defense", source: "purchase", credits: 1 }];
    case "challenge":
      await grantCredits({
        userId,
        kind: "challenge",
        amount: 1,
        reason: "purchase",
        source: "purchase",
        idempotencyKey: `${idempotencyKey}:challenge`,
      });
      return [{ kind: "challenge", source: "purchase", credits: 1 }];
    case "pack3":
    case "pack8":
      await grantCredits({
        userId,
        kind: "flex",
        amount: PACKS[sku].credits,
        reason: "purchase",
        source: "pack",
        idempotencyKey: `${idempotencyKey}:${sku}`,
      });
      return [{ kind: "flex", source: "pack", credits: PACKS[sku].credits }];
    case "subscription_month":
    case "subscription_year":
    case "team_month":
    case "enterprise_month":
      throw new HttpError(400, "Use a renewal for this plan.");
    default: {
      const unknown: never = sku;
      throw new HttpError(400, `Unknown price: ${String(unknown)}`);
    }
  }
}

async function grantsFromRenewal(userId: string, periodId: string): Promise<GrantSpec[]> {
  const db = await getDb();
  const keys = (["defense", "challenge", "learn_slot"] as const).map((kind) => `renew:${periodId}:${kind}`);
  const rows = await db.all<{ kind: string; amount: number | string; source: string | null }>(
    `SELECT kind, amount, source FROM credit_ledger WHERE user_id = ? AND idempotency_key IN (?, ?, ?)`,
    [userId, keys[0], keys[1], keys[2]],
  );
  return rows
    .filter((row) => Number(row.amount) > 0)
    .map((row) => ({
      kind: row.kind as LedgerKind,
      source: (row.source as CreditSource | null) ?? "subscription",
      credits: Number(row.amount),
    }));
}

async function rememberGrants(input: {
  userId: string;
  eventId: string;
  sku: string;
  grants: GrantSpec[];
  grantKey: string;
  checkoutSessionId?: string | null;
  invoiceId?: string | null;
  paymentIntentId?: string | null;
  chargeId?: string | null;
}): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  for (const grant of input.grants) {
    if (grant.credits <= 0) continue;
    await db.run(
      `INSERT INTO stripe_grants
        (id, user_id, event_id, sku, kind, source, credits, checkout_session_id, invoice_id,
         payment_intent_id, charge_id, refunded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        `${input.grantKey}:${grant.kind}`,
        input.userId,
        input.eventId,
        input.sku,
        grant.kind,
        grant.source,
        grant.credits,
        input.checkoutSessionId ?? null,
        input.invoiceId ?? null,
        input.paymentIntentId ?? null,
        input.chargeId ?? null,
        now,
      ],
    );
  }
}

async function rememberCustomer(userId: string, customerId: string | null): Promise<void> {
  if (!customerId) return;
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO billing_profiles (user_id, card_fingerprint, stripe_customer_id, updated_at)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       updated_at = excluded.updated_at`,
    [userId, customerId, now],
  );
}

async function userIdForCustomer(customerId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.get<{ user_id: string }>(
    `SELECT user_id FROM billing_profiles WHERE stripe_customer_id = ?`,
    [customerId],
  );
  return row?.user_id ?? null;
}

async function flagAccount(db: Db, userId: string, now: string): Promise<void> {
  await db.run(
    `INSERT INTO billing_profiles (user_id, card_fingerprint, flagged_at, flag_reason, updated_at)
     VALUES (?, NULL, ?, 'refund_credits_already_spent', ?)
     ON CONFLICT (user_id) DO UPDATE SET
       flagged_at = excluded.flagged_at,
       flag_reason = excluded.flag_reason,
       updated_at = excluded.updated_at`,
    [userId, now, now],
  );
}

async function eventSeen(eventId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.get(`SELECT event_id FROM stripe_events WHERE event_id = ?`, [eventId]);
  return !!row;
}

async function logEvent(eventId: string, eventType: string): Promise<BillingResult> {
  const db = await getDb();
  const inserted = await db.run(
    `INSERT INTO stripe_events (event_id, event_type, created_at) VALUES (?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, eventType, new Date().toISOString()],
  );
  return { duplicate: inserted.changes !== 1 };
}
