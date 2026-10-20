import { NextResponse } from "next/server";
import { z } from "zod";
import { appUrl } from "@/lib/config";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { createDefenseRequest } from "@/lib/services";

export const runtime = "nodejs";

const schema = z.object({
  difficulty: z.enum(["standard", "hard", "expert"]),
  title: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  pinnedClaims: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`request:${guard.user.id}`, LIMITS.requestCreatePerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const created = await createDefenseRequest({ owner: guard.user, kind: "receiver", ...body });
    return NextResponse.json({ token: created.token, shareUrl: appUrl(`/d/${created.token}`) });
  } catch (e) {
    return handleError(e, "Invalid request");
  }
}
