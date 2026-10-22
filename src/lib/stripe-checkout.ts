/**
 * Checkout Session creation. Tests replace the client so this file's
 * default path is the only one that can reach Stripe, and they never call it.
 *
 * Dynamic payment methods: `payment_method_types` is never set.
 * Adaptive Pricing is off so the charge stays in EUR.
 */

import { randomBytes } from "crypto";
import Stripe from "stripe";
import { HttpError } from "./errors";
import { stripeTaxEnabled } from "./stripe-config";
import { stripeSdk } from "./stripe-client";

export interface StripeCheckoutRequest {
  userId: string;
  email: string | null;
  customerId: string | null;
  sku: string;
  mode: "payment" | "subscription";
  priceId: string;
  lookupKey: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutApi {
  createSession(input: StripeCheckoutRequest): Promise<{ id: string; url: string | null }>;
}

export interface CheckoutLinePrice {
  lookupKey: string | null;
  priceId: string | null;
}

/** Params we send. Tests check metadata without a network call. */
export function checkoutSessionParams(input: StripeCheckoutRequest): Stripe.Checkout.SessionCreateParams {
  const metadata: Record<string, string> = {
    user_id: input.userId,
    sku: input.sku,
  };
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: input.mode,
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { ...metadata, lookup_key: input.lookupKey },
    adaptive_pricing: { enabled: false },
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: stripeTaxEnabled() },
    allow_promotion_codes: true,
    integration_identifier: integrationIdentifier(),
  };
  if (input.customerId) {
    params.customer = input.customerId;
  } else if (input.email && input.email.includes("@")) {
    params.customer_email = input.email;
    if (input.mode === "payment") params.customer_creation = "always";
  }
  if (input.mode === "subscription") {
    params.subscription_data = {
      metadata,
      billing_mode: { type: "flexible" },
    };
  } else {
    params.payment_intent_data = { metadata };
  }
  return params;
}

function integrationIdentifier(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(8);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `dit_checkout_${suffix}`;
}

let override: StripeCheckoutApi | null = null;
let lineLoader: ((sessionId: string) => Promise<CheckoutLinePrice[]>) | null = null;

/** Vitest injects a fake. Pass null to use the real client again. */
export function setStripeCheckoutApiForTests(api: StripeCheckoutApi | null): void {
  override = api;
}

/** Vitest injects expanded Checkout line items. Pass null to use Stripe. */
export function setCheckoutLineLoaderForTests(
  loader: ((sessionId: string) => Promise<CheckoutLinePrice[]>) | null,
): void {
  lineLoader = loader;
}

export function stripeCheckoutApi(): StripeCheckoutApi {
  if (override) return override;
  return defaultApi();
}

/**
 * Checkout webhooks often omit line items. Expand the price so the grant
 * can check lookup_key or price id.
 */
export async function loadCheckoutLinePrices(sessionId: string): Promise<CheckoutLinePrice[]> {
  if (lineLoader) return lineLoader(sessionId);
  try {
    const session = await stripeSdk().checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price"],
    });
    return (session.line_items?.data ?? []).map((line) => {
      const price = line.price;
      if (!price) return { lookupKey: null, priceId: null };
      if (typeof price === "string") return { lookupKey: null, priceId: price };
      return { lookupKey: price.lookup_key ?? null, priceId: price.id };
    });
  } catch (e) {
    if (e instanceof Stripe.errors.StripeError) {
      console.error("[stripe]", e.type, e.code ?? "");
      throw new HttpError(502, "Stripe could not load the checkout.");
    }
    throw e;
  }
}

function defaultApi(): StripeCheckoutApi {
  return {
    async createSession(input) {
      try {
        const session = await stripeSdk().checkout.sessions.create(checkoutSessionParams(input));
        return { id: session.id, url: session.url };
      } catch (e) {
        if (e instanceof Stripe.errors.StripeError) {
          console.error("[stripe]", e.type, e.code ?? "");
          throw new HttpError(502, "Stripe could not start checkout.");
        }
        throw e;
      }
    },
  };
}
