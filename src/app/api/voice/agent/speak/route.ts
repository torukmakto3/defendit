import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { handleError } from "@/lib/http";
import { withLlmScope } from "@/lib/llm";
import { prepareSpoken } from "@/lib/speech/llm-rewrite";

export const runtime = "nodejs";

const schema = z.object({
  text: z.string().min(1).max(8000),
  sessionId: z.string().min(1).max(64).optional(),
});

/**
 * Spoken form of one interviewer line. The agent still says the original
 * text into the transcript and sends only this string to TTS.
 */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await verifyAgentRequest(req));
    const result = body.sessionId
      ? await withLlmScope({ sessionId: body.sessionId }, () => prepareSpoken(body.text))
      : await prepareSpoken(body.text);
    return NextResponse.json({
      spoken: result.text,
      source: result.source,
      latencyMs: result.latencyMs,
    });
  } catch (e) {
    return handleError(e, "Could not prepare speech");
  }
}
