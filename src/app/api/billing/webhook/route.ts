import { NextResponse } from "next/server";
import { handleError, jsonError } from "@/lib/http";
import { applyBillingEvent } from "@/lib/payments";
import { liveStripeRefused, paymentsEnabled, stripeWebhookSecret, verifyStripeSignature } from "@/lib/stripe-config";

export const runtime = "nodejs";

/**
 * Stripe webhook. `request.text()` is the raw body (App Router does not parse
 * it first), which is what the signature MAC covers. Credits are granted
 * only after that check, once per event id.
 */
export async function POST(req: Request) {
  if (!paymentsEnabled()) return jsonError(404, "Not found");
  if (liveStripeRefused()) return jsonError(403, "Live Stripe keys are refused.");
  const secret = stripeWebhookSecret();
  if (!secret) return jsonError(501, "Stripe is not configured");
  try {
    const raw = await req.text();
    const event = verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret);
    const result = await applyBillingEvent(event);
    return NextResponse.json({ received: true, ...result });
  } catch (e) {
    return handleError(e, "Could not process the webhook");
  }
}
