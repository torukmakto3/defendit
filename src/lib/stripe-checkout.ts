/**
 * Checkout Session creation. Tests replace the client so this file's
 * default path is the only one that can reach Stripe, and they never call it.
 */

import Stripe from "stripe";
import { HttpError } from "./errors";

export interface StripeCheckoutRequest {
  userId: string;
  email: string | null;
  sku: string;
  priceId: string;
  lookupKey: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutApi {
  createSession(input: StripeCheckoutRequest): Promise<{ id: string; url: string | null }>;
}

/** Params we send. Pure, so tests can check metadata without a network call. */
export function checkoutSessionParams(input: StripeCheckoutRequest): Stripe.Checkout.SessionCreateParams {
  const metadata: Record<string, string> = {
    user_id: input.userId,
    sku: input.sku,
    lookup_key: input.lookupKey,
  };
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata,
    payment_intent_data: { metadata: { user_id: input.userId, sku: input.sku, lookup_key: input.lookupKey } },
  };
  if (input.email && input.email.includes("@")) params.customer_email = input.email;
  return params;
}

let override: StripeCheckoutApi | null = null;
let cached: { key: string; api: StripeCheckoutApi } | null = null;

/** Vitest injects a fake. Pass null to use the real client again. */
export function setStripeCheckoutApiForTests(api: StripeCheckoutApi | null): void {
  override = api;
  cached = null;
}

export function stripeCheckoutApi(): StripeCheckoutApi {
  if (override) return override;
  return defaultApi();
}

function defaultApi(): StripeCheckoutApi {
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!key) throw new HttpError(501, "Stripe is not configured");
  if (cached?.key === key) return cached.api;
  const stripe = new Stripe(key, { typescript: true, maxNetworkRetries: 1 });
  const api: StripeCheckoutApi = {
    async createSession(input) {
      try {
        const session = await stripe.checkout.sessions.create(checkoutSessionParams(input));
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
  cached = { key, api };
  return api;
}
