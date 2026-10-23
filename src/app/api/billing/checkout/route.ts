import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, ipLimitKey, jsonError, limitOr429, requireUser } from "@/lib/http";
import { createCheckout } from "@/lib/payments";
import { billingEnabled, isSku } from "@/lib/plans";
import { LIMITS } from "@/lib/ratelimit";
import { liveStripeRefused } from "@/lib/stripe-config";

export const runtime = "nodejs";

const schema = z.object({
  sku: z.string().refine(isSku, "Unknown price"),
});

/** Signed-in Checkout Session. Credits land in the webhook, not here. */
export async function POST(req: Request) {
  if (!billingEnabled()) return jsonError(402, "Billing is not enabled");
  if (liveStripeRefused()) return jsonError(403, "Live Stripe keys are refused.");
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  // IP first. A 429 from the address bucket must not increment checkout:<user>.
  const limited =
    (await limitOr429(ipLimitKey("checkout", req), LIMITS.checkoutPerIp)) ||
    (await limitOr429(`checkout:${guard.user.id}`, LIMITS.checkoutPerUser));
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    if (!isSku(body.sku)) return handleError(new Error("unreachable"));
    const session = await createCheckout({
      userId: guard.user.id,
      email: guard.user.email,
      sku: body.sku,
    });
    return NextResponse.json({ url: session.url, id: session.id });
  } catch (e) {
    return handleError(e, "Could not start checkout");
  }
}
