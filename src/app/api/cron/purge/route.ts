import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { jsonError } from "@/lib/http";
import { purgeExpired } from "@/lib/services";

export const runtime = "nodejs";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") || "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  if (!authorized(req)) return jsonError(401, "Unauthorized");
  return NextResponse.json({ ok: true, purged: await purgeExpired() });
}
