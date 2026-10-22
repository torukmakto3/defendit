import { NextResponse } from "next/server";
import { getUserFromRequest, isAdmin, type User } from "./auth";
import { HttpError } from "./errors";
import { ipRateKey, rateLimit } from "./ratelimit";

/** Shown with HTTP 429. Routes also set Retry-After. */
export const RATE_LIMIT_MESSAGE = "Too many requests right now. Please wait a moment and try again.";

export { HttpError };

export function jsonError(status: number, message: string, headers?: HeadersInit) {
  return NextResponse.json({ error: message }, { status, headers });
}

/**
 * Client address from the proxy headers. Do not store this value.
 * Rate-limit keys go through `ipRateKey`, which keeps only a hash.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/** Rate-limit bucket for this request's address, or null when there is no usable salt. */
export function ipLimitKey(scope: string, req: Request): string | null {
  return ipRateKey(scope, clientIp(req));
}

/**
 * Cross-site request guard for state-changing routes, on top of SameSite=Lax
 * cookies: a browser always sends Origin on cross-site POSTs.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type Guarded =
  | { user: User; response?: undefined }
  | { user?: undefined; response: NextResponse };

export async function requireUser(req: Request): Promise<Guarded> {
  if (req.method !== "GET" && !sameOrigin(req)) {
    return { response: jsonError(403, "Cross-site request blocked") };
  }
  const user = await getUserFromRequest(req);
  if (!user) return { response: jsonError(401, "Sign in required") };
  return { user };
}

export async function requireAdmin(req: Request): Promise<Guarded> {
  const guard = await requireUser(req);
  if (guard.response) return guard;
  if (!isAdmin(guard.user)) return { response: jsonError(403, "Admins only") };
  return guard;
}

export async function limitOr429(
  key: string | null,
  budget: { limit: number; windowSec: number },
): Promise<NextResponse | null> {
  if (!key) return null;
  const r = await rateLimit(key, budget.limit, budget.windowSec);
  if (r.ok) return null;
  return jsonError(429, RATE_LIMIT_MESSAGE, {
    "Retry-After": String(r.retryAfterSec),
  });
}

/** Map service errors to responses; unexpected errors get a generic message. */
export function handleError(e: unknown, fallback = "Request failed") {
  if (e instanceof HttpError) return jsonError(e.status, e.message);
  if (e && typeof e === "object" && "issues" in e) {
    return jsonError(400, "Invalid input");
  }
  console.error("[api]", e instanceof Error ? e.message : e);
  return jsonError(500, fallback);
}
