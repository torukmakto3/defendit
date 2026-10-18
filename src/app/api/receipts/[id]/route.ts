import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { verifyReceipt } from "@/lib/receipt";
import { getReceipt } from "@/lib/services";

export const runtime = "nodejs";

/** Public by design: the receipt holds a hash and a score, no content. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const receipt = await getReceipt(id);
  if (!receipt) return jsonError(404, "Not found");
  return NextResponse.json({ receipt, signatureValid: verifyReceipt(receipt) });
}
