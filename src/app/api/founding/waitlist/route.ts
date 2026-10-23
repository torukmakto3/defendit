import { NextResponse } from "next/server";
import { z } from "zod";
import { joinFoundingWaitlist, normalizeWaitlistEmail } from "@/lib/founding";
import { handleError, ipLimitKey, jsonError, limitOr429, sameOrigin } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().max(254),
});

/** Public waitlist. A repeat address answers the same way as a new one. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "Cross-site request blocked");
  const limited = await limitOr429(ipLimitKey("founding-waitlist", req), LIMITS.foundingWaitlistPerIp);
  if (limited) return limited;
  try {
    const body = bodySchema.parse(await req.json());
    const email = normalizeWaitlistEmail(body.email);
    if (!email) return jsonError(400, "Enter a valid email.");
    await joinFoundingWaitlist(email);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Could not join the waitlist");
  }
}
