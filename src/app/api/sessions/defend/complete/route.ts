import { NextResponse } from "next/server";
import { z } from "zod";
import { completeDefendSession } from "@/lib/services";

export const runtime = "nodejs";

const turnSchema = z.object({
  id: z.string(),
  probeId: z.string(),
  question: z.string(),
  answer: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  latencyMs: z.number(),
  followUpIndex: z.number(),
});

const schema = z.object({
  sessionId: z.string().min(1),
  turns: z.array(turnSchema).min(1),
  pasteEvents: z.number().optional(),
  focusBlurEvents: z.number().optional(),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const result = await completeDefendSession(body);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Grading failed" },
      { status: 400 },
    );
  }
}
