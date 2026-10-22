import { NextResponse } from "next/server";
import { restoreStudyDeck } from "@/lib/flashcards";
import { handleError, ipLimitKey, jsonError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { MAX_UPLOAD_BYTES } from "@/lib/services";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Rebuild a Learn deck from the same file after its text was deleted. The text is not stored. */
export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited =
      (await limitOr429(`ingest:${guard.user.id}`, LIMITS.ingestPerUser)) ||
      (await limitOr429(ipLimitKey("upload", req), LIMITS.uploadPerIp));
    if (limited) return limited;
    const form = await req.formData();
    const token = String(form.get("token") || "");
    const file = form.get("file");
    if (!token || !(file instanceof File)) return jsonError(400, "token and file are required");
    if (file.size > MAX_UPLOAD_BYTES) return jsonError(413, "File is too large");
    const result = await restoreStudyDeck({
      token,
      user: guard.user,
      fileName: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type || undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    return handleError(e, "Upload failed");
  }
}
