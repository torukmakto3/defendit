import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserFromRequest, isAdmin, setDisplayName } from "@/lib/auth";
import { handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  return NextResponse.json({
    user: user ? { email: user.email, displayName: user.display_name } : null,
    isAdmin: isAdmin(user),
  });
}

const schema = z.object({ displayName: z.string().max(80).nullable() });

export async function PATCH(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const { displayName } = schema.parse(await req.json());
    await setDisplayName(guard.user.id, displayName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
