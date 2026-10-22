import { NextResponse } from "next/server";
import { isClientAnalyticsEvent, trackingOptOut } from "@/lib/analytics";
import { track } from "@/lib/analytics-store";
import { ipLimitKey, sameOrigin } from "@/lib/http";
import { LIMITS, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const MAX_BODY = 2000;
/** One landing_view per hashed client inside this window. */
const LANDING_DEDUPE_SEC = 60;

function noStore() {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/**
 * Anonymous beacon for landing views and receipt share clicks.
 * No cookies are read. DNT and Sec-GPC skip the write before any rate-limit
 * bucket is touched. Per-client buckets use `ipLimitKey`. When `ipHash`
 * returns null those buckets are skipped. The global cap is charged after
 * them, so a blocked client does not consume it, and it still applies with no salt.
 */
export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return noStore();
    if (trackingOptOut(req.headers)) return noStore();
    const perMinuteKey = ipLimitKey("analytics:m", req);
    if (perMinuteKey) {
      const perMinute = await rateLimit(
        perMinuteKey,
        LIMITS.analyticsBeaconPerIp.limit,
        LIMITS.analyticsBeaconPerIp.windowSec,
      );
      if (!perMinute.ok) return noStore();
    }
    const perDayKey = ipLimitKey("analytics:d", req);
    if (perDayKey) {
      const perDay = await rateLimit(
        perDayKey,
        LIMITS.analyticsBeaconPerIpDay.limit,
        LIMITS.analyticsBeaconPerIpDay.windowSec,
      );
      if (!perDay.ok) return noStore();
    }
    const global = await rateLimit(
      "analytics:beacon",
      LIMITS.analyticsBeacon.limit,
      LIMITS.analyticsBeacon.windowSec,
    );
    if (!global.ok) return noStore();
    const raw = await req.text();
    if (raw.length === 0 || raw.length > MAX_BODY) return noStore();
    const body = JSON.parse(raw) as {
      name?: unknown;
      referrer?: unknown;
      props?: unknown;
    };
    if (typeof body.name !== "string" || !isClientAnalyticsEvent(body.name)) return noStore();
    if (body.name === "landing_view") {
      const landingKey = ipLimitKey("analytics:landing", req);
      if (landingKey) {
        const fresh = await rateLimit(landingKey, 1, LANDING_DEDUPE_SEC);
        if (!fresh.ok) return noStore();
      }
    }
    await track({
      name: body.name,
      referrer: typeof body.referrer === "string" ? body.referrer : null,
      props: body.props,
      headers: req.headers,
    });
    return noStore();
  } catch {
    return noStore();
  }
}
