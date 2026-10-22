import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, jsonError, requireUser } from "@/lib/http";
import { createCheckout } from "@/lib/payments";
import { isSku } from "@/lib/plans";
import { liveStripeRefused, paymentsEnabled } from "@/lib/stripe-config";

export const runtime = "nodejs";

const schema = z.object({
  sku: z.string().refine(isSku, "Unknown price"),
});

/** Signed-in Checkout Session. Credits land in the webhook, not here. */
export async function POST(req: Request) {
  if (!paymentsEnabled()) return jsonError(404, "Not found");
  if (liveStripeRefused()) return jsonError(403, "Live Stripe keys are refused.");
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
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
