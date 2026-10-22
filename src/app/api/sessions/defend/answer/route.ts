import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveDefenseSession } from "@/lib/demo";
import { handleError, limitOr429 } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { recordDefendAnswer } from "@/lib/services";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  probeId: z.string().min(1).max(64),
  answer: z.string().min(1).max(4000),
  pasteEvents: z.number().int().min(0).max(10_000).optional(),
  focusBlurEvents: z.number().int().min(0).max(10_000).optional(),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const actor = await resolveDefenseSession(req, body.sessionId);
    if (actor.response) return actor.response;
    const limited = await limitOr429(`answer:${actor.user.id}`, LIMITS.defendAnswerPerUser);
    if (limited) return limited;
    return NextResponse.json(await recordDefendAnswer({ ...body, user: actor.user }));
  } catch (e) {
    return handleError(e, "Could not save the answer");
  }
}
