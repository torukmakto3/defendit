import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { handleError } from "@/lib/http";
import { recordVoiceAnswer } from "@/lib/services";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  probeId: z.string().min(1).max(64),
  answer: z.string().min(1).max(8000),
  questionEndedAt: z.string().max(40),
  answerStartedAt: z.string().max(40),
  answerEndedAt: z.string().max(40),
});

/** The interviewer agent reports one transcribed answer with its timing (signed request). */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await verifyAgentRequest(req));
    return NextResponse.json(await recordVoiceAnswer(body));
  } catch (e) {
    return handleError(e, "Could not record the answer");
  }
}
