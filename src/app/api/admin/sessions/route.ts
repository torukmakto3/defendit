import { NextResponse } from "next/server";
import { listAdminSessions } from "@/lib/services";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ sessions: listAdminSessions() });
}
