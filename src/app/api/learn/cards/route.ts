import { NextResponse } from "next/server";
import { z } from "zod";
import type { User } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { dueCards, generateFlashcards, streamStudyDeck } from "@/lib/flashcards";
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
    const wantsStream = (req.headers.get("accept") || "").includes("application/x-ndjson");
    if (!wantsStream) {
      return NextResponse.json(await generateFlashcards({ token, user: guard.user, regenerate }));
    }
    return streamCards(token, guard.user, regenerate);
  } catch (e) {
    return handleError(e, "Could not make flashcards");
  }
}

function streamCards(token: string, user: User, regenerate: boolean | undefined) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          // The browser left. The deck keeps generating and is stored either way.
        }
      };
      try {
        const result = await streamStudyDeck({
          token,
          user,
          regenerate,
          onCard: (card) => send({ type: "card", card }),
        });
        send({ type: "done", ...result });
        controller.close();
      } catch (e) {
        send({
          type: "error",
          error: e instanceof HttpError ? e.message : "Could not make flashcards",
          status: e instanceof HttpError ? e.status : 500,
        });
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
