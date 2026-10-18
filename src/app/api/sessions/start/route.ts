import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { publicProbes, startSession } from "@/lib/services";
import { getVoiceProvider } from "@/lib/voice/providers";

export const runtime = "nodejs";

const schema = z.object({
  token: z.string().min(1).max(64),
  mode: z.enum(["learn", "defend"]),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const limited = await limitOr429(`start:${guard.user.id}`, LIMITS.sessionStartPerUser);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const session = await startSession({ ...body, user: guard.user });
    const voice = getVoiceProvider();
    const voiceSession = await voice.createSession({
      sessionId: session.sessionId,
      systemPrompt: `${body.mode} interview`,
      questionPlan: session.plan.probes.map((p) => p.question),
      silenceTimeoutMs: 30_000,
    });
    const probes = body.mode === "defend" ? publicProbes(session.plan) : undefined;

    return NextResponse.json({
      sessionId: session.sessionId,
      mode: body.mode,
      plan: body.mode === "defend" ? { ...session.plan, probes } : { probeCount: session.plan.probes.length },
      firstQuestion: probes?.[0]?.question,
      probes,
      voice: {
        provider: voice.id,
        modality: voice.modality,
        sessionHandle: voiceSession.sessionHandle,
      },
    });
  } catch (e) {
    return handleError(e, "Could not start session");
  }
}
