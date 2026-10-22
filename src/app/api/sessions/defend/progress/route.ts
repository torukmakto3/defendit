import { NextResponse } from "next/server";
import { handleError, requireUser } from "@/lib/http";
import { getDefendGradingProgress } from "@/lib/services";

export const runtime = "nodejs";

/** Polled while grading so the interview can show how many graders have finished. */
export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
    if (!sessionId || sessionId.length > 64) {
      return NextResponse.json({ error: "Missing session" }, { status: 400 });
    }
    return NextResponse.json(await getDefendGradingProgress(sessionId, guard.user));
  } catch (e) {
    return handleError(e, "Could not read grading progress");
  }
}
