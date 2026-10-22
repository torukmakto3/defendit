/**
 * One Stripe client. Classic Customers (`cus_…`), not Accounts v2.
 * Checkout, the portal, invoices, and the meter mapping in the plan all
 * take that customer id. API version is pinned to the 23.0.0 default.
 */

import Stripe from "stripe";
import { HttpError } from "./errors";

export const STRIPE_API_VERSION = "2026-09-30.endive" as const;

let cached: { key: string; stripe: Stripe } | null = null;

export function stripeSdk(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!key) throw new HttpError(501, "Stripe is not configured");
  if (cached?.key === key) return cached.stripe;
  const stripe = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    maxNetworkRetries: 1,
  });
  cached = { key, stripe };
  return stripe;
}

/** Local signature check. A bad signature is a 400, not a Stripe retry storm. */
export function constructStripeEvent(payload: string, header: string | null, secret: string): Stripe.Event {
  if (!header || !secret) throw new HttpError(400, "Invalid Stripe signature.");
  try {
    return Stripe.webhooks.constructEvent(payload, header, secret);
  } catch {
    throw new HttpError(400, "Invalid Stripe signature.");
  }
}

export interface InvoiceItemInput {
  customer: string;
  invoice: string;
  price: string;
  quantity: number;
}

let invoiceItems: ((input: InvoiceItemInput) => Promise<void>) | null = null;

export function setInvoiceItemWriterForTests(writer: ((input: InvoiceItemInput) => Promise<void>) | null): void {
  invoiceItems = writer;
}

export interface PortalInput {
  customerId: string;
  returnUrl: string;
  configurationId: string | null;
}

let portal: ((input: PortalInput) => Promise<string>) | null = null;

export function setBillingPortalForTests(writer: ((input: PortalInput) => Promise<string>) | null): void {
  portal = writer;
}

/** Hosted Customer Portal for a classic Customer id. */
export async function openBillingPortal(input: PortalInput): Promise<string> {
  if (portal) return portal(input);
  try {
    const session = await stripeSdk().billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      ...(input.configurationId ? { configuration: input.configurationId } : {}),
    });
    if (!session.url) throw new HttpError(502, "Stripe did not return a portal URL.");
    return session.url;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Stripe.errors.StripeError) {
      console.error("[stripe]", e.type, e.code ?? "");
      throw new HttpError(502, "Stripe could not open the billing portal.");
    }
    throw e;
  }
}

export interface ResolvedInvoicePayment {
  paymentIntentId: string | null;
  chargeId: string | null;
}

let invoicePaymentLoader: ((invoiceId: string) => Promise<ResolvedInvoicePayment | null>) | null = null;

/** Vitest supplies the paid InvoicePayment. Pass null to call Stripe. */
export function setInvoicePaymentLoaderForTests(
  loader: ((invoiceId: string) => Promise<ResolvedInvoicePayment | null>) | null,
): void {
  invoicePaymentLoader = loader;
}

/**
 * Basil and endive invoices do not carry `charge` or `payment_intent`.
 * The paid InvoicePayment does. A missing payment is null, not a throw:
 * the grant can still be recorded and a later event can fill the ids in.
 */
export async function resolveInvoicePayment(invoiceId: string): Promise<ResolvedInvoicePayment | null> {
  if (invoicePaymentLoader) return invoicePaymentLoader(invoiceId);
  if (!process.env.STRIPE_SECRET_KEY?.trim()) return null;
  try {
    const page = await stripeSdk().invoicePayments.list({
      invoice: invoiceId,
      status: "paid",
      limit: 10,
      expand: ["data.payment.payment_intent.latest_charge", "data.payment.charge"],
    });
    for (const row of page.data) {
      if (row.status !== "paid") continue;
      const payment = row.payment;
      if (payment.type === "payment_intent" && payment.payment_intent) {
        const intent = payment.payment_intent;
        const paymentIntentId = typeof intent === "string" ? intent : intent.id;
        const latest = typeof intent === "string" ? null : intent.latest_charge;
        const chargeId = latest == null ? null : typeof latest === "string" ? latest : latest.id;
        if (paymentIntentId || chargeId) return { paymentIntentId, chargeId };
      }
      if (payment.type === "charge" && payment.charge) {
        const charge = payment.charge;
        const chargeId = typeof charge === "string" ? charge : charge.id;
        const intent = typeof charge === "string" ? null : charge.payment_intent;
        const paymentIntentId = intent == null ? null : typeof intent === "string" ? intent : intent.id;
        if (paymentIntentId || chargeId) return { paymentIntentId, chargeId };
      }
    }
    return null;
  } catch (e) {
    if (e instanceof Stripe.errors.StripeError) {
      console.error("[stripe]", e.type, e.code ?? "");
      throw new HttpError(502, "Stripe could not load the invoice payment.");
    }
    throw e;
  }
}

let fingerprintLoader: ((paymentIntentId: string) => Promise<string | null>) | null = null;

/** Vitest supplies a card fingerprint. Pass null to read the PaymentIntent. */
export function setCardFingerprintLoaderForTests(
  loader: ((paymentIntentId: string) => Promise<string | null>) | null,
): void {
  fingerprintLoader = loader;
}

/**
 * Card fingerprint from the PaymentIntent's latest charge. A Stripe error
 * returns null so checkout still grants. The number itself is not stored.
 */
export async function loadCardFingerprint(paymentIntentId: string): Promise<string | null> {
  if (fingerprintLoader) return fingerprintLoader(paymentIntentId);
  if (!process.env.STRIPE_SECRET_KEY?.trim()) return null;
  try {
    const intent = await stripeSdk().paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge"],
    });
    const latest = intent.latest_charge;
    if (!latest || typeof latest === "string") return null;
    const fingerprint = latest.payment_method_details?.card?.fingerprint?.trim() ?? "";
    return fingerprint || null;
  } catch (e) {
    if (e instanceof Stripe.errors.StripeError) {
      console.error("[stripe]", e.type, e.code ?? "");
      return null;
    }
    throw e;
  }
}

export async function addInvoiceItem(input: InvoiceItemInput): Promise<void> {
  if (invoiceItems) {
    await invoiceItems(input);
    return;
  }
  try {
    await stripeSdk().invoiceItems.create({
      customer: input.customer,
      invoice: input.invoice,
      quantity: input.quantity,
      pricing: { price: input.price },
    });
  } catch (e) {
    if (e instanceof Stripe.errors.StripeError) {
      console.error("[stripe]", e.type, e.code ?? "");
      throw new HttpError(502, "Stripe could not add the overage line.");
    }
    throw e;
  }
}
