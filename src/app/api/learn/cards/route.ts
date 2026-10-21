import { NextResponse } from "next/server";
import { z } from "zod";
import { dueCards, generateFlashcards } from "@/lib/flashcards";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Cards due now, for one deliverable (?token=) or across all of them. */
export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const token = new URL(req.url).searchParams.get("token") || undefined;
    return NextResponse.json({ cards: await dueCards({ user: guard.user, token }) });
  } catch (e) {
    return handleError(e);
  }
}

const schema = z.object({
  token: z.string().min(1).max(64),
  regenerate: z.boolean().optional(),
});

/** Make flashcards for a deliverable. Cached per project unless regenerate is set. */
export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`cards:${guard.user.id}`, LIMITS.ingestPerUser);
    if (limited) return limited;
    const { token, regenerate } = schema.parse(await req.json());
    return NextResponse.json(await generateFlashcards({ token, user: guard.user, regenerate }));
  } catch (e) {
    return handleError(e, "Could not make flashcards");
  }
}
