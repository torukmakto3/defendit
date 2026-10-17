import { NextResponse } from "next/server";
import { verifyReceipt } from "@/lib/receipt";
import { getReceipt } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const receipt = getReceipt(id);
  if (!receipt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    receipt,
    signatureValid: verifyReceipt(receipt),
  });
}
