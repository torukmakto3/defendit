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
