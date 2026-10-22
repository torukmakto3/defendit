import { NextResponse } from "next/server";
import { revokeChallenge } from "@/lib/challenges";
import { handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const { slug } = await ctx.params;
    await revokeChallenge(slug, guard.user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Could not revoke the challenge");
  }
}
