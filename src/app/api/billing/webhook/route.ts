import { NextResponse } from "next/server";
import { handleError, jsonError } from "@/lib/http";
import { applyBillingEvent } from "@/lib/payments";
import { billingEnabled } from "@/lib/plans";
import { liveStripeRefused, stripeWebhookSecret } from "@/lib/stripe-config";
import { constructStripeEvent } from "@/lib/stripe-client";

export const runtime = "nodejs";

/**
 * Stripe webhook. `request.text()` is the raw body (App Router does not parse
 * it first), which is what the signature covers. Credits are granted only
 * after that check.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) return jsonError(402, "Billing is not enabled");
  if (liveStripeRefused()) return jsonError(403, "Live Stripe keys are refused.");
  const secret = stripeWebhookSecret();
  if (!secret) return jsonError(501, "Stripe is not configured");
  try {
    const raw = await req.text();
    const event = constructStripeEvent(raw, req.headers.get("stripe-signature"), secret);
    const result = await applyBillingEvent(event);
    return NextResponse.json({ received: true, ...result });
  } catch (e) {
    return handleError(e, "Could not process the webhook");
  }
}
