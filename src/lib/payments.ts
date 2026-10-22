/**
 * Stripe Checkout and webhooks, writing the credit ledger.
 * `BILLING_ENABLED` is the only switch. Off means 402 and no checkout UI.
 * A live key (`sk_live_` or `rk_live_`) is refused unless `STRIPE_ALLOW_LIVE=true`.
 *
 * Subscription periods are granted only from `invoice.paid`. Checkout credits
 * one-time purchases. Ledger keys are the Checkout session id or the invoice
 * id, so a second event for the same object does not credit again.
 * Customers are classic Stripe Customers (`cus_…`). See `stripe-client.ts`.
 */

import { z } from "zod";
import { appUrl } from "./config";
import {
  attachSubscription,
  clawbackCredits,
  endPaidPlan,
  grantCredits,
  markPlanPastDue,
  renewPlan,
  setCardFingerprint,
  type CreditSource,
  type LedgerKind,
} from "./credits";
import { getDb, type Db } from "./db";
import { HttpError } from "./errors";
import { billingEnabled, isSku, PACKS, planForSku, skuPriceCents, type Sku } from "./plans";
import { loadCheckoutLinePrices, stripeCheckoutApi } from "./stripe-checkout";
import {
  assertSkuForSale,
  checkoutMode,
  liveStripeRefused,
  stripePortalConfigurationId,
  stripeSecretKey,
} from "./stripe-config";
import { addInvoiceItem, openBillingPortal } from "./stripe-client";
import { lookupKeyForSku, resolveCheckoutPrice, resolvePrices, skuForLookupKey, STRIPE_LOOKUP_KEYS } from "./stripe-prices";

export { billingEnabled };

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

interface PriceRef {
  lookupKey: string | null;
  priceId: string | null;
}

const metaSchema = z
  .object({
    sku: z.string().optional(),
    user_id: z.string().optional(),
    lookup_key: z.string().optional(),
  })
  .nullish();

const idOrObject = z.union([z.string(), z.object({ id: z.string() })]).nullish();

const priceValue = z.union([z.string(), z.object({ id: z.string(), lookup_key: z.string().nullish() })]).nullish();

const sessionObject = z.object({
  id: z.string().min(1),
  client_reference_id: z.string().min(1).nullish(),
  payment_status: z.string().nullish(),
  mode: z.enum(["payment", "subscription", "setup"]).optional(),
  customer: idOrObject,
  payment_intent: idOrObject,
  subscription: idOrObject,
  metadata: metaSchema,
  line_items: z
    .object({
      data: z.array(z.object({ price: priceValue }).passthrough()),
    })
    .nullish(),
});

const checkoutEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
  ]),
  data: z.object({ object: sessionObject }),
});

const invoiceLine = z
  .object({
    price: priceValue,
    pricing: z
      .object({
        price_details: z.object({ price: priceValue }).nullish(),
      })
      .nullish(),
  })
  .passthrough();

const invoiceObject = z.object({
  id: z.string().min(1),
  customer: idOrObject,
  billing_reason: z.string().nullish(),
  charge: idOrObject,
  payment_intent: idOrObject,
  // Subscription invoices leave this empty. The sku is read from
  // parent.subscription_details, never from this object.
  metadata: metaSchema,
  parent: z
    .object({
      subscription_details: z
        .object({
          metadata: metaSchema,
          subscription: idOrObject,
        })
        .nullish(),
    })
    .nullish(),
  lines: z.object({ data: z.array(invoiceLine) }).nullish(),
});

const invoiceEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["invoice.paid", "invoice.payment_failed", "invoice.created", "invoice.finalized"]),
  data: z.object({ object: invoiceObject }),
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

const disputeEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("charge.dispute.created"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      charge: idOrObject,
      payment_intent: idOrObject,
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
      customer: idOrObject,
      metadata: metaSchema,
      cancel_at_period_end: z.boolean().nullish(),
      current_period_end: z.number().int().nullish(),
      items: z
        .object({
          data: z.array(z.object({ current_period_end: z.number().int().nullish() }).passthrough()),
        })
        .nullish(),
    }),
  }),
});

const HANDLED = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
  "charge.succeeded",
  "invoice.created",
  "invoice.finalized",
  "credit_note.created",
  "cash_balance.funds_available",
  "customer_cash_balance_transaction.created",
  "payment_method.attached",
  "payment_method.detached",
] as const;

type Handled = (typeof HANDLED)[number];

function isHandled(type: string): type is Handled {
  return (HANDLED as readonly string[]).includes(type);
}

const RENEW_REASONS = new Set(["", "subscription_create", "subscription_cycle", "subscription_update"]);

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
  if (!billingEnabled()) throw new HttpError(402, "Billing is not enabled");
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
    customerId: await customerIdForUser(input.userId),
    sku,
    mode: checkoutMode(sku),
    priceId: price.priceId,
    lookupKey: price.lookupKey,
    successUrl: `${appUrl("/dashboard")}?checkout={CHECKOUT_SESSION_ID}`,
    cancelUrl: appUrl("/billing/cancel"),
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL.");
  return { id: session.id, url: session.url };
}

/** Customer Portal for the stored classic Customer. */
export async function createBillingPortal(userId: string): Promise<{ url: string }> {
  if (!billingEnabled()) throw new HttpError(402, "Billing is not enabled");
  if (liveStripeRefused()) throw new HttpError(403, "Live Stripe keys are refused.");
  if (!stripeSecretKey()) throw new HttpError(501, "Stripe is not configured");
  const customerId = await customerIdForUser(userId);
  if (!customerId) throw new HttpError(400, "This account has no Stripe customer yet.");
  const url = await openBillingPortal({
    customerId,
    returnUrl: appUrl("/dashboard"),
    configurationId: stripePortalConfigurationId(),
  });
  return { url };
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
 * The same event id is a fast duplicate. The same Checkout session or
 * invoice is also a duplicate, even when Stripe sends a new event id.
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
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
      return applyCheckout(checkoutEventSchema.parse(event));
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.created":
    case "invoice.finalized":
      return applyInvoice(invoiceEventSchema.parse(event));
    case "charge.refunded":
      return applyRefund(refundEventSchema.parse(event));
    case "charge.dispute.created":
      return applyDispute(disputeEventSchema.parse(event));
    case "charge.succeeded":
      return applyCharge(chargeEventSchema.parse(event));
    case "customer.subscription.deleted":
    case "customer.subscription.updated":
      return applySubscription(subscriptionEventSchema.parse(event));
    case "credit_note.created":
    case "cash_balance.funds_available":
    case "customer_cash_balance_transaction.created":
    case "payment_method.attached":
    case "payment_method.detached":
      return logOnly(envelope.data.id, type);
    default: {
      const unknown: never = type;
      throw new HttpError(400, `Unhandled billing event: ${String(unknown)}`);
    }
  }
}

async function applyCheckout(event: z.infer<typeof checkoutEventSchema>): Promise<BillingResult> {
  const session = event.data.object;
  if (event.type === "checkout.session.async_payment_failed") {
    const userId = optionalAccount(session.client_reference_id, session.metadata?.user_id);
    if (userId) {
      await rememberCustomer(userId, stripeId(session.customer));
      await setPaymentNotice(userId, "The bank payment did not complete. No credits were added.");
    }
    await logEvent(event.id, event.type);
    return { duplicate: false, ignored: true };
  }
  if (session.payment_status !== "paid") {
    await logEvent(event.id, event.type);
    return { duplicate: false, ignored: true };
  }
  const skuRaw = session.metadata?.sku;
  if (!skuRaw || !isSku(skuRaw)) throw new HttpError(400, "Checkout is missing a price.");
  const sku = skuRaw;
  const userId = accountId(session.client_reference_id, session.metadata?.user_id);
  await requireUser(userId);
  await rememberCustomer(userId, stripeId(session.customer));
  const lines = await sessionLinePrices(session);
  await assertLinePrice(sku, lines);
  const plan = planForSku(sku);
  if (plan) {
    if (session.mode === "payment") throw new HttpError(400, "Subscription checkout has the wrong mode.");
    const subscriptionId = stripeId(session.subscription);
    if (subscriptionId) {
      await attachSubscription({
        userId,
        planId: plan.planId,
        interval: plan.interval,
        subscriptionId,
        status: "active",
        cancelAtPeriodEnd: false,
      });
    }
    await logEvent(event.id, event.type);
    return { duplicate: false };
  }
  if (await grantExists("checkout_session_id", session.id)) {
    await logEvent(event.id, event.type);
    return { duplicate: true };
  }
  const grantKey = `stripe:${session.id}`;
  const grants = await applyCreditSku(userId, sku, grantKey);
  await rememberGrants({
    userId,
    eventId: event.id,
    sku,
    grants,
    grantKey,
    checkoutSessionId: session.id,
    paymentIntentId: stripeId(session.payment_intent),
  });
  await setPaymentNotice(userId, null);
  return logEvent(event.id, event.type);
}

async function applyInvoice(event: z.infer<typeof invoiceEventSchema>): Promise<BillingResult> {
  switch (event.type) {
    case "invoice.paid":
      return applyInvoicePaid(event);
    case "invoice.payment_failed":
      return applyInvoiceFailed(event);
    case "invoice.created":
      return applyInvoiceCreated(event);
    case "invoice.finalized":
      return logOnly(event.id, event.type);
    default: {
      const unknown: never = event.type;
      throw new HttpError(400, `Unhandled invoice event: ${String(unknown)}`);
    }
  }
}

async function applyInvoicePaid(event: z.infer<typeof invoiceEventSchema>): Promise<BillingResult> {
  const invoice = event.data.object;
  const reason = invoice.billing_reason ?? "";
  if (!RENEW_REASONS.has(reason)) return logOnly(event.id, event.type);
  const resolved = resolveInvoiceIdentity(invoice);
  if (!isSku(resolved.sku)) throw new HttpError(400, "Invoice is missing a price.");
  const sku = resolved.sku;
  const plan = planForSku(sku);
  if (!plan) throw new HttpError(400, "Invoice is not a subscription.");
  await assertLinePrice(sku, invoiceLineRefs(invoice));
  await requireUser(resolved.userId);
  await rememberCustomer(resolved.userId, stripeId(invoice.customer));
  if (await grantExists("invoice_id", invoice.id)) {
    await logEvent(event.id, event.type);
    return { duplicate: true };
  }
  const periodId = `stripe:${invoice.id}`;
  const subscriptionId =
    stripeId(invoice.parent?.subscription_details?.subscription) ?? null;
  await renewPlan({
    userId: resolved.userId,
    planId: plan.planId,
    interval: plan.interval,
    periodId,
    subscriptionId,
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
  await setPaymentNotice(resolved.userId, null);
  return logEvent(event.id, event.type);
}

async function applyInvoiceFailed(event: z.infer<typeof invoiceEventSchema>): Promise<BillingResult> {
  const invoice = event.data.object;
  const userId = invoiceUser(invoice);
  if (!userId) {
    await logEvent(event.id, event.type);
    return { duplicate: false, unmatched: true };
  }
  const exists = await userExists(userId);
  if (!exists) {
    await logEvent(event.id, event.type);
    return { duplicate: false, unmatched: true };
  }
  await markPlanPastDue(userId);
  await setPaymentNotice(userId, "Payment failed. Update the card in the billing portal.");
  return logEvent(event.id, event.type);
}

async function applyInvoiceCreated(event: z.infer<typeof invoiceEventSchema>): Promise<BillingResult> {
  const invoice = event.data.object;
  const customerId = stripeId(invoice.customer);
  const userId = customerId ? await userIdForCustomer(customerId) : invoiceUser(invoice);
  if (!customerId || !userId) return logOnly(event.id, event.type);
  const db = await getDb();
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM billing_overages WHERE user_id = ? AND ref_type = 'hold' ORDER BY created_at`,
    [userId],
  );
  if (rows.length === 0) return logOnly(event.id, event.type);
  const prices = await resolvePrices([STRIPE_LOOKUP_KEYS.enterpriseExtraUnit]);
  const priceId = prices.get(STRIPE_LOOKUP_KEYS.enterpriseExtraUnit)?.priceId;
  if (!priceId) {
    throw new HttpError(502, `Stripe catalog is missing lookup key ${STRIPE_LOOKUP_KEYS.enterpriseExtraUnit}.`);
  }
  await addInvoiceItem({
    customer: customerId,
    invoice: invoice.id,
    price: priceId,
    quantity: rows.length,
  });
  for (const row of rows) {
    await db.run(
      `UPDATE billing_overages SET ref_type = 'stripe_invoice', ref_id = ? WHERE id = ? AND ref_type = 'hold'`,
      [invoice.id, row.id],
    );
  }
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
  return clawGrants({
    eventId: event.id,
    eventType: event.type,
    chargeId: charge.id,
    paymentIntentId: charge.payment_intent?.trim() || null,
    flagReason: "refund_credits_already_spent",
    flagOnShortfallOnly: true,
    clawKey: (grantId) => `clawback:${grantId}`,
  });
}

async function applyDispute(event: z.infer<typeof disputeEventSchema>): Promise<BillingResult> {
  const dispute = event.data.object;
  return clawGrants({
    eventId: event.id,
    eventType: event.type,
    chargeId: stripeId(dispute.charge),
    paymentIntentId: stripeId(dispute.payment_intent),
    flagReason: "dispute_opened",
    flagOnShortfallOnly: false,
    clawKey: (grantId) => `stripe:${dispute.id}:${grantId}`,
  });
}

async function clawGrants(input: {
  eventId: string;
  eventType: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  flagReason: string;
  flagOnShortfallOnly: boolean;
  clawKey: (grantId: string) => string;
}): Promise<BillingResult> {
  const db = await getDb();
  let duplicate = false;
  let unmatched = false;
  await db.transaction(async (tx) => {
    const inserted = await tx.run(
      `INSERT INTO stripe_events (event_id, event_type, created_at) VALUES (?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING`,
      [input.eventId, input.eventType, new Date().toISOString()],
    );
    if (inserted.changes !== 1) {
      duplicate = true;
      return;
    }
    const grants = await tx.all<GrantRow>(
      `SELECT id, user_id, kind, source, credits, refunded_at FROM stripe_grants
       WHERE (? IS NOT NULL AND charge_id = ?) OR (? IS NOT NULL AND payment_intent_id = ?)`,
      [input.chargeId, input.chargeId, input.paymentIntentId, input.paymentIntentId],
    );
    if (grants.length === 0) {
      unmatched = true;
      return;
    }
    let shortfall = false;
    const now = new Date().toISOString();
    for (const grant of grants) {
      if (grant.refunded_at) continue;
      const result = await clawbackCredits({
        userId: grant.user_id,
        kind: grant.kind as LedgerKind,
        source: grant.source as CreditSource,
        amount: Number(grant.credits),
        idempotencyKey: input.clawKey(grant.id),
        refType: "stripe_refund",
        refId: input.eventId,
        db: tx,
      });
      if (result.shortfall > 0) shortfall = true;
      await tx.run(`UPDATE stripe_grants SET refunded_at = ? WHERE id = ? AND refunded_at IS NULL`, [
        now,
        grant.id,
      ]);
    }
    if (shortfall || !input.flagOnShortfallOnly) await flagAccount(tx, grants[0].user_id, input.flagReason, now);
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
  const userId =
    sub.metadata?.user_id?.trim() ||
    (stripeId(sub.customer) ? await userIdForCustomer(stripeId(sub.customer) as string) : null);
  if (!userId || !(await userExists(userId))) {
    await logEvent(event.id, event.type);
    return { duplicate: false, unmatched: true };
  }
  if (event.type === "customer.subscription.deleted") {
    await endPaidPlan(userId, sub.id);
    await setPaymentNotice(userId, null);
    return logEvent(event.id, event.type);
  }
  const skuRaw = sub.metadata?.sku?.trim() ?? "";
  const plan = isSku(skuRaw) ? planForSku(skuRaw) : null;
  if (plan) {
    await attachSubscription({
      userId,
      planId: plan.planId,
      interval: plan.interval,
      subscriptionId: sub.id,
      status: subscriptionStatus(sub.status),
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      periodEnd: periodEndIso(sub),
    });
  } else if (sub.status === "past_due" || sub.status === "unpaid") {
    await markPlanPastDue(userId);
  }
  return logEvent(event.id, event.type);
}

function subscriptionStatus(status: string): "active" | "past_due" | "canceled" {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
  }
}

function periodEndIso(sub: {
  current_period_end?: number | null;
  items?: { data: { current_period_end?: number | null }[] } | null;
}): string | null {
  const unix =
    sub.items?.data.find((item) => item.current_period_end)?.current_period_end ?? sub.current_period_end ?? null;
  if (!unix) return null;
  return new Date(unix * 1000).toISOString();
}

function resolveInvoiceIdentity(invoice: z.infer<typeof invoiceObject>): { sku: string; userId: string } {
  const meta = invoice.parent?.subscription_details?.metadata;
  const userId = meta?.user_id?.trim() ?? "";
  if (!userId) throw new HttpError(400, "Invoice is missing an account.");
  const fromParent = meta?.sku?.trim() ?? "";
  if (fromParent) return { sku: fromParent, userId };
  for (const ref of invoiceLineRefs(invoice)) {
    if (!ref.lookupKey) continue;
    const sku = skuForLookupKey(ref.lookupKey);
    if (sku) return { sku, userId };
  }
  throw new HttpError(400, "Invoice is missing a price.");
}

function invoiceUser(invoice: z.infer<typeof invoiceObject>): string | null {
  const userId = invoice.parent?.subscription_details?.metadata?.user_id?.trim() ?? "";
  return userId || null;
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

function optionalAccount(ref: string | null | undefined, meta: string | undefined): string | null {
  try {
    return accountId(ref, meta);
  } catch {
    return null;
  }
}

async function sessionLinePrices(session: z.infer<typeof sessionObject>): Promise<PriceRef[]> {
  const present = (session.line_items?.data ?? [])
    .map((line) => readPrice(line.price))
    .filter((ref): ref is PriceRef => ref != null);
  if (present.length > 0) return present;
  const loaded = await loadCheckoutLinePrices(session.id);
  return loaded;
}

function invoiceLineRefs(invoice: z.infer<typeof invoiceObject>): PriceRef[] {
  const refs: PriceRef[] = [];
  for (const line of invoice.lines?.data ?? []) {
    const fromPricing = readPrice(line.pricing?.price_details?.price);
    const fromPrice = readPrice(line.price);
    if (fromPricing) refs.push(fromPricing);
    else if (fromPrice) refs.push(fromPrice);
  }
  return refs;
}

function readPrice(value: string | { id: string; lookup_key?: string | null } | null | undefined): PriceRef | null {
  if (typeof value === "string" && value.trim()) return { lookupKey: null, priceId: value.trim() };
  if (value && typeof value === "object" && value.id.trim()) {
    return { lookupKey: value.lookup_key?.trim() || null, priceId: value.id.trim() };
  }
  return null;
}

/**
 * Accept the line when its lookup key is the sku's key. A bare price id is
 * accepted only when it is the catalog id for that same key. Amounts are not
 * compared: tax, promos, and prorations change them.
 */
async function assertLinePrice(sku: Sku, refs: PriceRef[]): Promise<void> {
  const expected = lookupKeyForSku(sku);
  if (!expected) throw new HttpError(400, "Price does not match the plan.");
  const keyed = refs.filter((ref) => ref.lookupKey);
  if (keyed.length > 0) {
    if (keyed.some((ref) => ref.lookupKey === expected)) return;
    throw new HttpError(400, "Price does not match the plan.");
  }
  const ids = refs.map((ref) => ref.priceId).filter((id): id is string => !!id);
  if (ids.length > 0) {
    const prices = await resolvePrices([expected]);
    const priceId = prices.get(expected)?.priceId ?? null;
    if (priceId && ids.includes(priceId)) return;
  }
  throw new HttpError(400, "Price does not match the plan.");
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && value.id.trim()) return value.id.trim();
  return null;
}

async function requireUser(userId: string): Promise<void> {
  if (!(await userExists(userId))) throw new HttpError(404, "Account not found.");
}

async function userExists(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
  return !!row;
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

async function grantExists(column: "checkout_session_id" | "invoice_id", id: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.get(
    `SELECT id FROM stripe_grants WHERE ${column} = ? LIMIT 1`,
    [id],
  );
  return !!row;
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

async function customerIdForUser(userId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.get<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM billing_profiles WHERE user_id = ?`,
    [userId],
  );
  return row?.stripe_customer_id ?? null;
}

async function userIdForCustomer(customerId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.get<{ user_id: string }>(
    `SELECT user_id FROM billing_profiles WHERE stripe_customer_id = ?`,
    [customerId],
  );
  return row?.user_id ?? null;
}

async function setPaymentNotice(userId: string, notice: string | null): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  if (notice == null) {
    await db.run(`UPDATE billing_profiles SET payment_notice = NULL, updated_at = ? WHERE user_id = ?`, [
      now,
      userId,
    ]);
    return;
  }
  await db.run(
    `INSERT INTO billing_profiles (user_id, card_fingerprint, payment_notice, updated_at)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       payment_notice = excluded.payment_notice,
       updated_at = excluded.updated_at`,
    [userId, notice, now],
  );
}

async function flagAccount(db: Db, userId: string, reason: string, now: string): Promise<void> {
  await db.run(
    `INSERT INTO billing_profiles (user_id, card_fingerprint, flagged_at, flag_reason, updated_at)
     VALUES (?, NULL, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       flagged_at = excluded.flagged_at,
       flag_reason = excluded.flag_reason,
       updated_at = excluded.updated_at`,
    [userId, now, reason, now],
  );
}

async function eventSeen(eventId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.get(`SELECT event_id FROM stripe_events WHERE event_id = ?`, [eventId]);
  return !!row;
}

async function logOnly(eventId: string, eventType: string): Promise<BillingResult> {
  await logEvent(eventId, eventType);
  return { duplicate: false, ignored: true };
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
