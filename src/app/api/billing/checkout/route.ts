import { z } from "zod";
import { handleError, requireUser } from "@/lib/http";
import { createCheckout } from "@/lib/payments";
import { isSku } from "@/lib/plans";

export const runtime = "nodejs";

const schema = z.object({
  sku: z.string().refine(isSku, "Unknown price"),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const body = schema.parse(await req.json());
    if (!isSku(body.sku)) return handleError(new Error("unreachable"));
    createCheckout({ userId: guard.user.id, sku: body.sku });
  } catch (e) {
    return handleError(e, "Could not start checkout");
  }
}
