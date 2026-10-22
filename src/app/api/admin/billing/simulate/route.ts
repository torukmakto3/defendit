import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/auth";
import { handleError, jsonError, requireUser } from "@/lib/http";
import { simulatePurchase, simulateRenewal } from "@/lib/payments";
import { isSku } from "@/lib/plans";
import { isDeployed } from "@/lib/secrets";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["purchase", "renewal"]),
  sku: z.string().refine(isSku, "Unknown price"),
  idempotencyKey: z.string().min(8).max(200),
});

/** Dev and admin stand-in for a paid checkout or a renewal. Writes the ledger only. */
export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  if (isDeployed() && !isAdmin(guard.user)) return jsonError(403, "Admins only");
  try {
    const body = schema.parse(await req.json());
    if (!isSku(body.sku)) return handleError(new Error("unreachable"));
    if (body.action === "purchase") {
      await simulatePurchase({ userId: guard.user.id, sku: body.sku, idempotencyKey: body.idempotencyKey });
    } else {
      await simulateRenewal({ userId: guard.user.id, sku: body.sku, idempotencyKey: body.idempotencyKey });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Could not simulate billing");
  }
}
