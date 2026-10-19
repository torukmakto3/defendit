import { NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { handleError } from "@/lib/http";
import { voicePlan } from "@/lib/services";

export const runtime = "nodejs";

/** The interviewer agent fetches the questions it may ask (signed request). */
export async function POST(req: Request) {
  try {
    const { sessionId } = await verifyAgentRequest<{ sessionId: string }>(req);
    return NextResponse.json(await voicePlan(String(sessionId)));
  } catch (e) {
    return handleError(e);
  }
}
