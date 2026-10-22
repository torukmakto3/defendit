import { NextResponse } from "next/server";
import { z } from "zod";
import { getOptOut, setOptOut } from "@/lib/challenges";
import { handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  optedOut: z.boolean(),
  handles: z.array(z.string().max(40)).max(8).optional(),
});

export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    return NextResponse.json(await getOptOut(guard.user));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const body = schema.parse(await req.json());
    return NextResponse.json(await setOptOut(guard.user, body.optedOut, body.handles ?? []));
  } catch (e) {
    return handleError(e, "Could not save that preference");
  }
}
