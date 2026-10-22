import { NextResponse } from "next/server";
import { z } from "zod";
import type { User } from "@/lib/auth";
import { challengeCoversDefense } from "@/lib/challenges";
import { abortDefenseCredit, attachDefenseCredit, beginDefenseCredit } from "@/lib/credits";
import { handleError, HttpError, ipLimitKey, limitOr429, requireUser } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { publicProbes, startSession, type FirstQuestionInfo } from "@/lib/services";
import { recordStageTiming } from "@/lib/timings";
import { getVoiceProvider } from "@/lib/voice/providers";

export const runtime = "nodejs";

const schema = z.object({
  token: z.string().min(1).max(64),
  mode: z.enum(["learn", "defend"]),
  voice: z.boolean().optional(),
  accommodation: z.boolean().optional(),
});

export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  let creditKey: string | null = null;
  let sessionId: string | null = null;
  try {
    const limited =
      (await limitOr429(`start:${guard.user.id}`, LIMITS.sessionStartPerUser)) ||
      (await limitOr429(ipLimitKey("start", req), LIMITS.sessionStartPerIp));
    if (limited) return limited;
    const body = schema.parse(await req.json());
    // A challenge defense does not spend the defender's defense credit.
    // startSession reserves the shared beta budget for a beta challenge.
    if (body.mode === "defend" && !(await challengeCoversDefense(body.token, guard.user.id))) {
      const reserved = await beginDefenseCredit(guard.user.id);
      creditKey = reserved.idempotencyKey;
    }
    if (body.mode === "defend" && creditKey && (req.headers.get("accept") || "").includes("application/x-ndjson")) {
      return streamDefendStart(body, guard.user, creditKey);
    }
    const session = await startSession({ ...body, user: guard.user });
    sessionId = session.sessionId;
    if (creditKey) await attachDefenseCredit(guard.user.id, creditKey, session.sessionId);
    const voice = getVoiceProvider();
    const voiceStarted = Date.now();
    const voiceSession = await voice.createSession({
      sessionId: session.sessionId,
      systemPrompt: `${body.mode} interview`,
      questionPlan: session.plan.probes.map((p) => p.question),
      silenceTimeoutMs: 30_000,
    });
    if (body.mode === "defend") {
      await recordStageTiming({
        sessionId: session.sessionId,
        stage: "tts_first_audio",
        detail: voice.modality === "voice" ? voice.id : "text",
        durationMs: voice.modality === "voice" ? Date.now() - voiceStarted : 0,
      });
    }
    const probes = body.mode === "defend" ? publicProbes(session.plan) : undefined;

    return NextResponse.json({
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      mode: body.mode,
      channel: session.channel,
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
    // A challenge defense has no per-start credit. Its euro reservation stays
    // when this start fails or is replaced by a newer one. Decline, expiry,
    // and revoke release it. Releasing it here would take it from that newer start.
    if (creditKey) {
      try {
        await abortDefenseCredit(guard.user.id, creditKey, sessionId);
      } catch (abortError) {
        console.error("[credits] refund", abortError instanceof Error ? abortError.message : abortError);
      }
    }
    return handleError(e, "Could not start session");
  }
}

/**
 * First line is question 1. Later lines carry the rest of the plan.
 * The credit is held before the stream starts. It is attached once the
 * session row exists. If that attach throws, the hold is refunded. A later
 * failure, after the hold is attached, keeps that one unfinished defense.
 */
function streamDefendStart(body: z.infer<typeof schema>, user: User, creditKey: string) {
  const encoder = new TextEncoder();
  let voiceMeta: { provider: string; modality: string; sessionHandle: string } | null = null;
  let sessionId: string | null = null;
  let attached = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      try {
        const session = await startSession({
          ...body,
          user,
          onFirstQuestion: async (info) => {
            sessionId = info.sessionId;
            await attachDefenseCredit(user.id, creditKey, info.sessionId);
            attached = true;
            send({
              type: "question",
              sessionId: info.sessionId,
              channel: info.channel,
              total: info.total,
              startedAt: info.startedAt,
              text: info.question,
              probe: info.probe,
            });
            const opened = await openVoice(info);
            voiceMeta = opened.meta;
            await recordStageTiming({
              requestId: info.requestId,
              sessionId: info.sessionId,
              stage: "tts_first_audio",
              detail: opened.meta.modality === "voice" ? opened.meta.provider : "text-stream",
              durationMs: opened.durationMs,
            });
            send({
              type: "audio",
              provider: opened.meta.provider,
              modality: opened.meta.modality,
              firstAudioMs: opened.durationMs,
            });
          },
        });
        if (!attached) {
          sessionId = session.sessionId;
          await attachDefenseCredit(user.id, creditKey, session.sessionId);
          attached = true;
        }
        const probes = publicProbes(session.plan);
        send({
          type: "ready",
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          mode: body.mode,
          channel: session.channel,
          plan: { ...session.plan, probes },
          firstQuestion: probes[0]?.question,
          probes,
          voice: voiceMeta,
        });
        controller.close();
      } catch (e) {
        if (!attached) {
          try {
            await abortDefenseCredit(user.id, creditKey, sessionId);
          } catch (abortError) {
            console.error("[credits] refund", abortError instanceof Error ? abortError.message : abortError);
          }
        }
        if (!(e instanceof HttpError)) console.error("[api]", e instanceof Error ? e.message : e);
        send({ type: "error", error: e instanceof HttpError ? e.message : "Could not start session" });
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function openVoice(info: FirstQuestionInfo) {
  const voice = getVoiceProvider();
  const started = Date.now();
  const voiceSession = await voice.createSession({
    sessionId: info.sessionId,
    systemPrompt: "defend interview",
    questionPlan: [info.question],
    silenceTimeoutMs: 30_000,
  });
  return {
    durationMs: voice.modality === "voice" ? Date.now() - started : 0,
    meta: {
      provider: voice.id,
      modality: voice.modality,
      sessionHandle: voiceSession.sessionHandle,
    },
  };
}
