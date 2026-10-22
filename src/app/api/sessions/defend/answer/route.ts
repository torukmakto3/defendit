import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, limitOr429, requireUser } from "@/lib/http";
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
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`answer:${guard.user.id}`, LIMITS.defendAnswerPerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    return NextResponse.json(await recordDefendAnswer({ ...body, user: guard.user }));
  } catch (e) {
    return handleError(e, "Could not save the answer");
  }
}
