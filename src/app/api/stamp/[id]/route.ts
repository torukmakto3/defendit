import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getReceipt } from "@/lib/services";
import { generateStampSvg } from "@/lib/stamp";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const receipt = await getReceipt(id);
  if (!receipt) return jsonError(404, "Stamp not found");
  const svg = await generateStampSvg({ payload: receipt.payload, verifyUrl: receipt.verifyUrl });
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    },
  });
}
