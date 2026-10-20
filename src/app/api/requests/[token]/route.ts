import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { handleError } from "@/lib/http";
import { getRequestView } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const user = await getUserFromRequest(req);
    return NextResponse.json(await getRequestView(token, user));
  } catch (e) {
    return handleError(e);
  }
}
