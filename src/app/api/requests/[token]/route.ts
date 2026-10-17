import { NextResponse } from "next/server";
import { getLatestDeliverable, getRequestByToken } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const request = getRequestByToken(token);
  if (!request) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const deliverable = getLatestDeliverable(request.id);
  return NextResponse.json({
    request,
    deliverable: deliverable
      ? {
          id: deliverable.id,
          fileName: deliverable.file_name,
          sha256: deliverable.sha256,
          byteLength: deliverable.byte_length,
          claimCount: JSON.parse(deliverable.claims_json).length,
        }
      : null,
  });
}
