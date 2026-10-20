import { NextResponse } from "next/server";
import { handleError, jsonError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { creatorIngest, MAX_UPLOAD_BYTES } from "@/lib/services";
import type { Difficulty } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`ingest:${guard.user.id}`, LIMITS.ingestPerUser);
    if (limited) return limited;
    const form = await req.formData();
    const difficulty = String(form.get("difficulty") || "hard") as Difficulty;
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError(400, "file is required");
    if (file.size > MAX_UPLOAD_BYTES) return jsonError(413, "File is too large");
    if (!["standard", "hard", "expert"].includes(difficulty)) {
      return jsonError(400, "invalid difficulty");
    }

    const result = await creatorIngest({
      user: guard.user,
      fileName: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      difficulty,
      mimeType: file.type || undefined,
    });
    return NextResponse.json({
      token: result.token,
      sha256: result.sha256,
      claimCount: result.claimCount,
      title: result.title,
      learnUrl: `/d/${result.token}/learn`,
      defendUrl: `/d/${result.token}/defend`,
      workspaceUrl: `/d/${result.token}`,
    });
  } catch (e) {
    return handleError(e, "Ingest failed");
  }
}
