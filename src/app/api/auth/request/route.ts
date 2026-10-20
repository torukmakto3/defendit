import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeEmail, requestMagicLink } from "@/lib/auth";
import { sha256Hex } from "@/lib/crypto";
import { clientIp, handleError, jsonError, limitOr429, sameOrigin } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(254),
  next: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "Cross-site request blocked");
  try {
    const body = schema.parse(await req.json());
    const email = normalizeEmail(body.email);
    const limited =
      (await limitOr429(`login:ip:${clientIp(req)}`, LIMITS.loginPerIp)) ||
      (await limitOr429(`login:email:${sha256Hex(email)}`, LIMITS.loginPerEmail));
    if (limited) return limited;
    const { devLink } = await requestMagicLink({ email, nextPath: body.next });
    return NextResponse.json({ ok: true, devLink });
  } catch (e) {
    return handleError(e, "Could not send a sign-in link");
  }
}
