import { NextResponse } from "next/server";
import { declineChallenge } from "@/lib/challenges";
import { clientIp, handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const { slug } = await ctx.params;
    const result = await declineChallenge(slug, guard.user, clientIp(req));
    return NextResponse.json({ ok: true, closed: result.closed });
  } catch (e) {
    return handleError(e, "Could not close this challenge");
  }
}
