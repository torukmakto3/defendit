import { NextResponse } from "next/server";
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
