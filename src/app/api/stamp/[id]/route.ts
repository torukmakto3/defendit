import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { receiptGate } from "@/lib/challenges";
import { jsonError } from "@/lib/http";
import { getReceipt } from "@/lib/services";
import { generateStampSvg } from "@/lib/stamp";
import { renderStampPng } from "@/lib/stamp-png";

export const runtime = "nodejs";

/**
 * The stamp image. SVG for inline display on the receipt page; PNG
 * (?format=png) for pasting into email, Slack or Docs. ?download=1 adds a
 * filename with the right extension.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await receiptGate(id, await getUserFromRequest(req));
  if (gate.mode === "challenge" && !gate.includeReceipt) return jsonError(404, "Stamp not found");
  const receipt = await getReceipt(id);
  if (!receipt) return jsonError(404, "Stamp not found");
  const url = new URL(req.url);
  const svg = await generateStampSvg({ payload: receipt.payload, verifyUrl: receipt.verifyUrl });
  const download = url.searchParams.get("download") === "1";
  const name = `defend-it-stamp-${receipt.payload.id}`;

  if (url.searchParams.get("format") === "png") {
    const png = renderStampPng(svg);
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400, immutable",
        ...(download ? { "Content-Disposition": `attachment; filename="${name}.png"` } : {}),
      },
    });
  }
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      ...(download ? { "Content-Disposition": `attachment; filename="${name}.svg"` } : {}),
    },
  });
}
