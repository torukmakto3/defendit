import { NextResponse } from "next/server";
import { z } from "zod";
import { startSession } from "@/lib/services";
import { getVoiceProvider } from "@/lib/voice/providers";

export const runtime = "nodejs";

const schema = z.object({
  token: z.string().min(1),
  mode: z.enum(["learn", "defend"]),
  creatorName: z.string().min(1),
  creatorEmail: z.string().email(),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const session = startSession(body);
    const voice = getVoiceProvider();
    const voiceSession = await voice.createSession({
      sessionId: session.sessionId,
      systemPrompt: `${body.mode} interview`,
      questionPlan: session.plan.probes.map((p) => p.question),
      silenceTimeoutMs: 30_000,
    });

    return NextResponse.json({
      sessionId: session.sessionId,
      mode: body.mode,
      plan: body.mode === "defend" ? session.plan : { probeCount: session.plan.probes.length },
      firstQuestion:
        body.mode === "defend" ? session.plan.probes[0]?.question : undefined,
      probes: body.mode === "defend" ? session.plan.probes : undefined,
      voice: {
        provider: voice.id,
        modality: voice.modality,
        sessionHandle: voiceSession.sessionHandle,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not start session" },
      { status: 400 },
    );
  }
}
