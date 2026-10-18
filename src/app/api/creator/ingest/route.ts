import { NextResponse } from "next/server";
import { creatorIngest } from "@/lib/services";
import type { Difficulty } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const creatorName = String(form.get("creatorName") || "Creator");
    const creatorEmail = String(form.get("creatorEmail") || "creator@example.com");
    const difficulty = String(form.get("difficulty") || "hard") as Difficulty;
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    if (!["standard", "hard", "expert"].includes(difficulty)) {
      return NextResponse.json({ error: "invalid difficulty" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await creatorIngest({
      fileName: file.name,
      buffer,
      creatorName,
      creatorEmail,
      difficulty,
      mimeType: file.type || undefined,
    });

    return NextResponse.json({
      token: result.token,
      requestId: result.requestId,
      deliverableId: result.deliverableId,
      sha256: result.sha256,
      claimCount: result.claims.length,
      title: result.title,
      learnUrl: `/d/${result.token}/learn`,
      defendUrl: `/d/${result.token}/defend`,
      workspaceUrl: `/d/${result.token}`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ingest failed" },
      { status: 400 },
    );
  }
}
