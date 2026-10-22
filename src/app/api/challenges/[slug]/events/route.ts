import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth";
import { recordShareClick } from "@/lib/challenges";
import { handleError, ipLimitKey, limitOr429 } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const schema = z.object({
  event: z.literal("share_clicked"),
  channel: z.enum(["x", "copy"]),
});

/** Records a share click. Nothing in the product waits on this event. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const limited = await limitOr429(ipLimitKey("challenge-share", req), LIMITS.challengeSharePerIp);
    if (limited) return limited;
    const { slug } = await ctx.params;
    const body = schema.parse(await req.json());
    const user = await getUserFromRequest(req);
    await recordShareClick(slug, user, body.channel);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Could not record that");
  }
}
