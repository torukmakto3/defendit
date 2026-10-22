import { NextResponse } from "next/server";
import { z } from "zod";
import { chooseVisibility } from "@/lib/challenges";
import { handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  visibility: z.enum(["public", "score_hidden", "private"]),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const { slug } = await ctx.params;
    const body = schema.parse(await req.json());
    return NextResponse.json(await chooseVisibility({ slug, user: guard.user, visibility: body.visibility }));
  } catch (e) {
    return handleError(e, "Could not save that choice");
  }
}
