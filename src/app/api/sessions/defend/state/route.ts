import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveDefenseStart } from "@/lib/demo";
import { handleError, jsonError } from "@/lib/http";
import { getDefendInterviewState } from "@/lib/services";

export const runtime = "nodejs";

const query = z.object({ token: z.string().min(1).max(64) });

/**
 * The open defend session for this link, so a reload continues it.
 * A sample demo is authorized by its demo cookie, the same way a start is.
 */
export async function GET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    const parsed = query.safeParse({ token });
    if (!parsed.success) return noStore(jsonError(400, "Missing defense"));
    const actor = await resolveDefenseStart(req, parsed.data.token);
    if (actor.response) return noStore(actor.response);
    const state = await getDefendInterviewState(parsed.data.token, actor.user);
    return noStore(NextResponse.json(actor.demo ? { ...state, demo: true } : state));
  } catch (e) {
    return noStore(handleError(e, "Could not resume the interview"));
  }
}

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}
