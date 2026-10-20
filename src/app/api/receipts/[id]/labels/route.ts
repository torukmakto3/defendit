import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { handleError } from "@/lib/http";
import { receiptClaimLabels } from "@/lib/services";

export const runtime = "nodejs";

/** Claim section names for the receipt's creator; null for everyone else. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const user = await getUserFromRequest(req);
    return NextResponse.json({ labels: user ? await receiptClaimLabels(id, user) : null });
  } catch (e) {
    return handleError(e);
  }
}
