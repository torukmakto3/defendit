import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { handleError } from "@/lib/http";
import { recordVoiceFirstAudio } from "@/lib/timings";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  durationMs: z.number().int().min(0).max(120_000),
});

/** The interviewer reports when the creator first hears speech. Signed like the other agent routes. */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await verifyAgentRequest(req));
    await recordVoiceFirstAudio(body.sessionId, body.durationMs);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Could not record timing");
  }
}
