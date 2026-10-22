import { NextResponse } from "next/server";
import { googleAuthConfigured } from "@/lib/auth";
import {
  beginGoogleOAuth,
  GoogleAuthError,
  GOOGLE_OAUTH_COOKIE,
  googleOAuthCookieOptions,
  googleRedirectMatchesHost,
  nextPathFromRequest,
  pathWithAuthError,
  requestHost,
  requestOrigin,
} from "@/lib/google-auth";
import { handleError, ipLimitKey, jsonError, limitOr429 } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!googleAuthConfigured()) return jsonError(404, "Google sign-in is not configured");
  try {
    const limited = await limitOr429(ipLimitKey("login", req), LIMITS.loginPerIp);
    if (limited) return limited;
    const explicit = new URL(req.url).searchParams.get("next");
    const next = nextPathFromRequest(req, explicit);
    let matches = false;
    try {
      matches = googleRedirectMatchesHost(requestHost(req));
    } catch {
      matches = false;
    }
    if (!matches) {
      const res = NextResponse.redirect(new URL(pathWithAuthError(next, "wrong_host"), requestOrigin(req)));
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    const started = beginGoogleOAuth(next);
    const res = NextResponse.redirect(started.authorizationUrl);
    res.cookies.set(GOOGLE_OAUTH_COOKIE, started.cookieValue, googleOAuthCookieOptions());
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      const res = NextResponse.redirect(new URL(pathWithAuthError("/", e.code), requestOrigin(req)));
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    return handleError(e, "Could not start Google sign-in");
  }
}
