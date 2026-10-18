import { NextResponse } from "next/server";
import { handleError, requireUser } from "@/lib/http";
import { listDashboard } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    return NextResponse.json({ rows: await listDashboard(guard.user) });
  } catch (e) {
    return handleError(e);
  }
}
