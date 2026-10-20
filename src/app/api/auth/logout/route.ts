import { NextResponse } from "next/server";
import { endSession, SESSION_COOKIE } from "@/lib/auth";
import { jsonError, sameOrigin } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "Cross-site request blocked");
  await endSession(req);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
