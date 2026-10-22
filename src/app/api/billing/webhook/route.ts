import { jsonError } from "@/lib/http";
import { billingEnabled } from "@/lib/payments";

export const runtime = "nodejs";

/**
 * Closed until billing is on and a signature check exists. The handler
 * `applyBillingEvent` is what this route will call after that check.
 * Nothing here contacts a payment provider.
 */
export async function POST() {
  if (!billingEnabled()) return jsonError(402, "billing not enabled");
  return jsonError(501, "Stripe is not configured");
}
