import { after, NextResponse } from "next/server";
import { z } from "zod";
import { settlePendingStudyDecks } from "@/lib/flashcards";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { completeDefendSession } from "@/lib/services";

export const runtime = "nodejs";
// The council waits up to the grader timeout (default 55s, clamped near 59s), including one retry, in parallel.
// A budget-fallback grader uses only the time left before this deadline, minus 10s.
// 120s covers that wait plus signing. It is under Fluid's 300s Hobby ceiling, so every plan can run it.
export const maxDuration = 120;

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  pasteEvents: z.number().int().min(0).max(10_000).optional(),
  focusBlurEvents: z.number().int().min(0).max(10_000).optional(),
  showName: z.boolean().optional(),
});

export async function POST(req: Request) {
  const deadlineMs = Date.now() + maxDuration * 1000;
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  let deckStarted = false;
  try {
    const limited = await limitOr429(`defend:${guard.user.id}`, LIMITS.defendCompletePerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    deckStarted = true;
    const result = await completeDefendSession({
      ...body,
      user: guard.user,
      waitForStudyDeck: false,
      deadlineMs,
      analyticsHeaders: req.headers,
    });
    return NextResponse.json(result);
  } catch (e) {
    return handleError(e, "Grading failed");
  } finally {
    if (deckStarted) after(() => settlePendingStudyDecks());
  }
}
