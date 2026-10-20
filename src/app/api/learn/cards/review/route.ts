import { NextResponse } from "next/server";
import { z } from "zod";
import { reviewCard } from "@/lib/flashcards";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const schema = z.object({
  cardId: z.string().min(1).max(64),
  rating: z.enum(["again", "hard", "good", "easy"]),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`review:${guard.user.id}`, LIMITS.defendAnswerPerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    return NextResponse.json(await reviewCard({ ...body, user: guard.user }));
  } catch (e) {
    return handleError(e, "Could not save the review");
  }
}
