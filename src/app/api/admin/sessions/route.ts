import { NextResponse } from "next/server";
import { handleError, requireAdmin } from "@/lib/http";
import { adminSessionsCsv, listAdminSessions } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  try {
    const { sessions, summary } = await listAdminSessions();
    if (new URL(req.url).searchParams.get("format") === "csv") {
      return new NextResponse(adminSessionsCsv(sessions), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"defense-costs.csv\"",
        },
      });
    }
    return NextResponse.json({ sessions, summary });
  } catch (e) {
    return handleError(e);
  }
}
