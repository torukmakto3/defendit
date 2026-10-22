import { NextResponse } from "next/server";
import { z } from "zod";
import { consumeMagicLink, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { handleError, ipLimitKey, jsonError, limitOr429, sameOrigin } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const schema = z.object({ token: z.string().min(20).max(200) });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "Cross-site request blocked");
  try {
    const limited = await limitOr429(ipLimitKey("verify", req), LIMITS.loginPerIp);
    if (limited) return limited;
    const { token } = schema.parse(await req.json());
    const result = await consumeMagicLink(token);
    if (!result) return jsonError(400, "This sign-in link is invalid, used, or expired.");
    const res = NextResponse.json({ ok: true, next: result.nextPath });
    res.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions());
    return res;
  } catch (e) {
    return handleError(e, "Could not sign in");
  }
}
