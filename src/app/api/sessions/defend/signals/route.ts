import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { recordIntegritySignals } from "@/lib/services";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  pasteEvents: z.number().int().min(0).max(10_000).optional(),
  focusBlurEvents: z.number().int().min(0).max(10_000).optional(),
});

/** Store the running paste and focus-loss totals. A repeat cannot lower them. */
export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`signals:${guard.user.id}`, LIMITS.defendSignalsPerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    return NextResponse.json(await recordIntegritySignals({ ...body, user: guard.user }));
  } catch (e) {
    return handleError(e, "Could not save the integrity signals");
  }
}
