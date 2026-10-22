import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { handleError, ipLimitKey, jsonError, limitOr429 } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { parseStatsDays, statsBearerOk, statsReport, statsToken } from "@/lib/stats";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/** Aggregate traction counts. Bearer STATS_TOKEN. No rows, ids, or document text. */
export async function GET(req: Request) {
  const secret = statsToken();
  if (!secret) return jsonError(404, "Not found", NO_STORE);
  try {
    const limited = await limitOr429(ipLimitKey("stats", req), LIMITS.statsRead);
    if (limited) {
      limited.headers.set("Cache-Control", "no-store");
      return limited;
    }
    if (!statsBearerOk(req.headers.get("authorization"), secret)) {
      return jsonError(401, "Unauthorized", NO_STORE);
    }
    const days = parseStatsDays(new URL(req.url).searchParams.get("days"));
    if (days == null) return jsonError(400, "days must be a positive whole number or all", NO_STORE);
    const body = await statsReport(await getDb(), { days });
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    const res = handleError(e);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
