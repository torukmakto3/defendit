import { NextResponse } from "next/server";
import { z } from "zod";
import { closeLearnProject } from "@/lib/credits";
import { listProjects } from "@/lib/flashcards";
import { handleError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    return NextResponse.json({ projects: await listProjects(guard.user) });
  } catch (e) {
    return handleError(e);
  }
}

const closeSchema = z.object({ token: z.string().min(1).max(80) });

/** Close a Learn project so its slot can be used again. The file's retention is unchanged. */
export async function DELETE(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const body = closeSchema.parse(await req.json());
    await closeLearnProject(guard.user.id, body.token);
    return NextResponse.json({ closed: true });
  } catch (e) {
    return handleError(e);
  }
}
