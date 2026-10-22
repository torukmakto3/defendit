import { NextResponse } from "next/server";
import { isClientAnalyticsEvent, trackingOptOut } from "@/lib/analytics";
import { track } from "@/lib/analytics-store";
import { sameOrigin } from "@/lib/http";
import { LIMITS, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const MAX_BODY = 2000;

function noStore() {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/**
 * Anonymous beacon for landing views and receipt share clicks.
 * No cookies are read, and no user id is stored. DNT and Sec-GPC skip the write.
 */
export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return noStore();
    if (trackingOptOut(req.headers)) return noStore();
    const limited = await rateLimit(
      "analytics:beacon",
      LIMITS.analyticsBeacon.limit,
      LIMITS.analyticsBeacon.windowSec,
    );
    if (!limited.ok) return noStore();
    const raw = await req.text();
    if (raw.length === 0 || raw.length > MAX_BODY) return noStore();
    const body = JSON.parse(raw) as {
      name?: unknown;
      referrer?: unknown;
      props?: unknown;
      subjectId?: unknown;
    };
    if (typeof body.name !== "string" || !isClientAnalyticsEvent(body.name)) return noStore();
    await track({
      name: body.name,
      referrer: typeof body.referrer === "string" ? body.referrer : null,
      props: body.props,
      subjectId: typeof body.subjectId === "string" ? body.subjectId : null,
      headers: req.headers,
    });
    return noStore();
  } catch {
    return noStore();
  }
}
