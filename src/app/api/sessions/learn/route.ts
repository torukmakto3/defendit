import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { learnCoachTurn } from "@/lib/services";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  answer: z.string().max(4000).optional(),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`learn:${guard.user.id}`, LIMITS.learnTurnPerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    return NextResponse.json(await learnCoachTurn({ ...body, user: guard.user }));
  } catch (e) {
    return handleError(e, "Learn turn failed");
  }
}
