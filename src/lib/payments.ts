/**
 * Billing stub. No payment SDK is imported and no request leaves the process.
 * `BILLING_ENABLED=false` (or unset) makes the HTTP routes answer
 * "billing not enabled". Turning the flag on still refuses with
 * "Stripe is not configured" until a client is added. `applyBillingEvent`
 * is the webhook shape those routes will call after a signature check:
 * `checkout.session.completed` and `invoice.paid`.
 */

import { z } from "zod";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { grantCredits, renewPlan } from "./credits";
import {
  billingEnabled,
  isSku,
  PACKS,
  planForSku,
  skuPriceCents,
  type Sku,
} from "./plans";

export { billingEnabled };

const skuSchema = z.string().refine(isSku, "Unknown price");

const checkoutEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("checkout.session.completed"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      client_reference_id: z.string().min(1).nullish(),
      payment_status: z.string(),
      amount_total: z.number().int(),
      currency: z.string(),
      metadata: z
        .object({
          sku: skuSchema,
          user_id: z.string().min(1).optional(),
        })
        .nullish(),
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
      metadata: z.object({
        sku: skuSchema,
        user_id: z.string().min(1),
      }),
    }),
  }),
});

const billingEventSchema = z.discriminatedUnion("type", [checkoutEventSchema, invoiceEventSchema]);

export type BillingEvent = z.infer<typeof billingEventSchema>;

/** Checkout is not created. This function does not call fetch. */
export function createCheckout(input: { userId: string; sku: Sku }): never {
  if (!input.userId || !input.sku) throw new HttpError(400, "Checkout is missing an account.");
  if (!billingEnabled()) throw new HttpError(402, "billing not enabled");
  throw new HttpError(501, "Stripe is not configured");
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
 * Apply a verified webhook fixture. Callers must check the signature first.
 * This function only writes the ledger.
 */
export async function applyBillingEvent(event: unknown): Promise<{ duplicate: boolean }> {
  const parsed = billingEventSchema.parse(event);
  switch (parsed.type) {
    case "checkout.session.completed":
      return applyCheckout(parsed);
    case "invoice.paid":
      return applyInvoice(parsed);
    default: {
      const unreachable: never = parsed;
      throw new HttpError(400, `Unhandled billing event: ${String(unreachable)}`);
    }
  }
}

async function applyCheckout(event: z.infer<typeof checkoutEventSchema>): Promise<{ duplicate: boolean }> {
  const session = event.data.object;
  if (session.payment_status !== "paid") throw new HttpError(400, "Checkout is not paid.");
  const sku = session.metadata?.sku;
  if (!sku || !isSku(sku)) throw new HttpError(400, "Checkout is missing a price.");
  assertPrice(session.currency, session.amount_total, sku);
  const userId = session.client_reference_id || session.metadata?.user_id;
  if (!userId) throw new HttpError(400, "Checkout is missing an account.");
  await requireUser(userId);
  const plan = planForSku(sku);
  if (plan) {
    await renewPlan({
      userId,
      planId: plan.planId,
      interval: plan.interval,
      periodId: `stripe:${event.id}`,
    });
  } else {
    await applyCreditSku(userId, sku, `stripe:${event.id}`);
  }
  return logEvent(event.id, event.type);
}

async function applyInvoice(event: z.infer<typeof invoiceEventSchema>): Promise<{ duplicate: boolean }> {
  const invoice = event.data.object;
  const sku = invoice.metadata.sku;
  if (!isSku(sku)) throw new HttpError(400, "Invoice is missing a price.");
  const plan = planForSku(sku);
  if (!plan) throw new HttpError(400, "Invoice is not a subscription.");
  assertPrice(invoice.currency, invoice.amount_paid, sku);
  await requireUser(invoice.metadata.user_id);
  await renewPlan({
    userId: invoice.metadata.user_id,
    planId: plan.planId,
    interval: plan.interval,
    periodId: `stripe:${event.id}`,
  });
  return logEvent(event.id, event.type);
}

function assertPrice(currency: string, amountCents: number, sku: Sku): void {
  if (currency.toLowerCase() !== "eur") throw new HttpError(400, "Price must be in EUR.");
  if (amountCents !== skuPriceCents(sku)) throw new HttpError(400, "Price does not match the plan.");
}

async function requireUser(userId: string): Promise<void> {
  const db = await getDb();
  const row = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
  if (!row) throw new HttpError(404, "Account not found.");
}

async function applyCreditSku(userId: string, sku: Sku, idempotencyKey: string): Promise<void> {
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
      return;
    case "challenge":
      await grantCredits({
        userId,
        kind: "challenge",
        amount: 1,
        reason: "purchase",
        source: "purchase",
        idempotencyKey: `${idempotencyKey}:challenge`,
      });
      return;
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
      return;
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

async function logEvent(eventId: string, eventType: string): Promise<{ duplicate: boolean }> {
  const db = await getDb();
  const inserted = await db.run(
    `INSERT INTO stripe_events (event_id, event_type, created_at) VALUES (?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, eventType, new Date().toISOString()],
  );
  return { duplicate: inserted.changes !== 1 };
}
