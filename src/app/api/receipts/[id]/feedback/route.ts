import { NextResponse } from "next/server";
import { z } from "zod";
import { feedbackForReceipt, FEEDBACK_COMMENT_MAX, saveDefenseFeedback } from "@/lib/feedback";
import { handleError, ipLimitKey, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const bodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(FEEDBACK_COMMENT_MAX).optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireUser(req);
  const userId = guard.user?.id ?? null;
  try {
    return NextResponse.json(await feedbackForReceipt(id, userId));
  } catch (e) {
    return handleError(e, "Could not load feedback");
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  const limited =
    (await limitOr429(`feedback:${guard.user.id}`, LIMITS.feedbackPerUser)) ||
    (await limitOr429(ipLimitKey("feedback", req), LIMITS.feedbackPerIp));
  if (limited) return limited;
  try {
    const { id } = await ctx.params;
    const body = bodySchema.parse(await req.json());
    await saveDefenseFeedback({
      receiptId: id,
      userId: guard.user.id,
      rating: body.rating,
      comment: body.comment,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Could not save feedback");
  }
}
