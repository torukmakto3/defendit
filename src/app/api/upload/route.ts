import { NextResponse } from "next/server";
import { ingestDeliverable } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const token = String(form.get("token") || "");
    const creatorName = String(form.get("creatorName") || "");
    const creatorEmail = String(form.get("creatorEmail") || "");
    const file = form.get("file");

    if (!token || !creatorName || !creatorEmail || !(file instanceof File)) {
      return NextResponse.json(
        { error: "token, creatorName, creatorEmail, and file are required" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await ingestDeliverable({
      token,
      fileName: file.name,
      buffer,
      creatorName,
      creatorEmail,
      mimeType: file.type || undefined,
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 400 },
    );
  }
}
