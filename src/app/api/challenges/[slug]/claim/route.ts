import { NextResponse } from "next/server";
import { z } from "zod";
import { claimChallenge } from "@/lib/challenges";
import { clientIp, handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  adultConfirmed: z.boolean(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const { slug } = await ctx.params;
    const body = schema.parse(await req.json());
    const claimed = await claimChallenge({
      slug,
      user: guard.user,
      ip: clientIp(req),
      adultConfirmed: body.adultConfirmed,
    });
    return NextResponse.json(claimed);
  } catch (e) {
    return handleError(e, "Could not accept the challenge");
  }
}
