import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, jsonError, requireUser } from "@/lib/http";
import { getDefendInterviewState } from "@/lib/services";

export const runtime = "nodejs";

const query = z.object({ token: z.string().min(1).max(64) });

/** The open defend session for this link, so a reload continues it. */
export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    const parsed = query.safeParse({ token });
    if (!parsed.success) return jsonError(400, "Missing defense");
    return NextResponse.json(await getDefendInterviewState(parsed.data.token, guard.user));
  } catch (e) {
    return handleError(e, "Could not resume the interview");
  }
}
