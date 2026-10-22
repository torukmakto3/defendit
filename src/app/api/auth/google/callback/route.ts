import { NextResponse } from "next/server";
import { readRequestCookie, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import {
  decodeOAuthTxn,
  GoogleAuthError,
  GOOGLE_OAUTH_COOKIE,
  googleOAuthCookieOptions,
  pathWithAuthError,
  requestOrigin,
  resolveGoogleCallback,
} from "@/lib/google-auth";
import { ipLimitKey, limitOr429 } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clearOAuthCookie(res: NextResponse) {
  res.cookies.set(GOOGLE_OAUTH_COOKIE, "", { ...googleOAuthCookieOptions(), maxAge: 0 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const stored = decodeOAuthTxn(readRequestCookie(req, GOOGLE_OAUTH_COOKIE));
  const next = stored?.nextPath ?? "/";
  const limited = await limitOr429(ipLimitKey("verify", req), LIMITS.loginPerIp);
  if (limited) return limited;

  const fail = (code: string) => {
    const res = NextResponse.redirect(new URL(pathWithAuthError(next, code), requestOrigin(req)));
    clearOAuthCookie(res);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };

  try {
    const result = await resolveGoogleCallback({
      stored,
      returnedState: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      providerError: url.searchParams.get("error"),
    });
    const res = NextResponse.redirect(new URL(result.nextPath, requestOrigin(req)));
    res.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions());
    clearOAuthCookie(res);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    if (!(e instanceof GoogleAuthError)) {
      console.error("[auth] google callback", e instanceof Error ? e.message : e);
    }
    return fail(e instanceof GoogleAuthError ? e.code : "failed");
  }
}
