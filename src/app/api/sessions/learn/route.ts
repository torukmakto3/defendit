import { NextResponse } from "next/server";
import { z } from "zod";
import { learnCoachTurn } from "@/lib/services";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1),
  answer: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const result = await learnCoachTurn(body);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Learn turn failed" },
      { status: 400 },
    );
  }
}
