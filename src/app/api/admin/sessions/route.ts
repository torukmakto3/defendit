import { NextResponse } from "next/server";
import { handleError, requireAdmin } from "@/lib/http";
import { listAdminSessions } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  try {
    return NextResponse.json({ sessions: await listAdminSessions() });
  } catch (e) {
    return handleError(e);
  }
}
