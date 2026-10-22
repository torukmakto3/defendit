import { NextResponse } from "next/server";
import { funnelReport } from "@/lib/analytics-store";
import { handleError, requireAdmin } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  try {
    return NextResponse.json(await funnelReport());
  } catch (e) {
    return handleError(e);
  }
}
