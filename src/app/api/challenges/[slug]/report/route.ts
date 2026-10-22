import { NextResponse } from "next/server";
import { z } from "zod";
import { reportChallenge } from "@/lib/challenges";
import { clientIp, handleError } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  note: z.string().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => ({})));
    await reportChallenge(slug, clientIp(req), body.note);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Could not send the report");
  }
}
