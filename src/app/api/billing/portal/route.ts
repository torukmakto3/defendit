import { NextResponse } from "next/server";
import { handleError, jsonError, requireUser } from "@/lib/http";
import { createBillingPortal } from "@/lib/payments";
import { billingEnabled } from "@/lib/plans";
import { liveStripeRefused } from "@/lib/stripe-config";

export const runtime = "nodejs";

/** Hosted Customer Portal. The customer id is the one stored for this account. */
export async function POST(req: Request) {
  if (!billingEnabled()) return jsonError(402, "Billing is not enabled");
  if (liveStripeRefused()) return jsonError(403, "Live Stripe keys are refused.");
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const portal = await createBillingPortal(guard.user.id);
    return NextResponse.json(portal);
  } catch (e) {
    return handleError(e, "Could not open the billing portal");
  }
}
