import { NextResponse } from "next/server";
import { z } from "zod";
import { createChallenge } from "@/lib/challenges";
import { handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  subject: z.string().min(1).max(500),
  sourceUrl: z.string().max(500).optional(),
  targetHint: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
  difficulty: z.enum(["standard", "hard", "expert"]),
  sponsorType: z.enum(["beta", "paid"]).optional(),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const body = schema.parse(await req.json());
    const created = await createChallenge({ user: guard.user, ...body });
    return NextResponse.json(created);
  } catch (e) {
    return handleError(e, "Could not create the challenge");
  }
}
