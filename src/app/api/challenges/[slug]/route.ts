import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getPublicChallenge } from "@/lib/challenges";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const user = await getUserFromRequest(req);
  const view = await getPublicChallenge(slug, user);
  if (!view) return jsonError(404, "Challenge not found.");
  return NextResponse.json(view);
}
