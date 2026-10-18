import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { completeDefendSession } from "@/lib/services";

export const runtime = "nodejs";
export const maxDuration = 120;

const turnSchema = z.object({
  id: z.string().max(64),
  probeId: z.string().max(64),
  question: z.string().max(2000),
  answer: z.string().max(4000),
  startedAt: z.string().max(40),
  endedAt: z.string().max(40),
  latencyMs: z.number(),
  followUpIndex: z.number(),
});

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  turns: z.array(turnSchema).min(1).max(40),
  pasteEvents: z.number().optional(),
  focusBlurEvents: z.number().optional(),
  showName: z.boolean().optional(),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`defend:${guard.user.id}`, LIMITS.defendCompletePerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    return NextResponse.json(await completeDefendSession({ ...body, user: guard.user }));
  } catch (e) {
    return handleError(e, "Grading failed");
  }
}
