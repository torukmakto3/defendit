import { NextResponse } from "next/server";
import { resolveDefenseSession } from "@/lib/demo";
import { handleError } from "@/lib/http";
import { getDefendGradingProgress } from "@/lib/services";

export const runtime = "nodejs";

/** Polled while grading so the interview can show how many graders have finished. */
export async function GET(req: Request) {
  try {
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
    if (!sessionId || sessionId.length > 64) {
      return NextResponse.json({ error: "Missing session" }, { status: 400 });
    }
    const actor = await resolveDefenseSession(req, sessionId);
    if (actor.response) return actor.response;
    return NextResponse.json(await getDefendGradingProgress(sessionId, actor.user));
  } catch (e) {
    return handleError(e, "Could not read grading progress");
  }
}
