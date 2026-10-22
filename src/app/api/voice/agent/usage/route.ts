import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { handleError } from "@/lib/http";
import { recordSessionVoiceUsage } from "@/lib/services";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1).max(64),
  agentSeconds: z.number().min(0).max(3 * 60 * 60),
  sttSeconds: z.number().min(0).max(3 * 60 * 60).optional(),
  ttsSeconds: z.number().min(0).max(3 * 60 * 60).optional(),
});

/** The interviewer reports how long the LiveKit session ran. Signed like the other agent routes. */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await verifyAgentRequest(req));
    const usage = await recordSessionVoiceUsage(body);
    return NextResponse.json({ ok: true, voiceCostUsd: usage.voiceCostUsd });
  } catch (e) {
    return handleError(e, "Could not record voice usage");
  }
}
