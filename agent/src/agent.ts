/**
 * Defend It voice interviewer (LiveKit agent).
 *
 * Scripted on purpose: it asks only the questions our server already wrote
 * for this deliverable, in order, and reports each spoken answer (with timing)
 * back to the server, which grades exactly as for typed answers. This process
 * does not call a model. When SPEECH_REWRITE_LLM=1, the server may paraphrase
 * a line before it is spoken; grading still uses the original question text.
 *
 * Privacy: with a Deepgram key, STT (and TTS, while TTS_PROVIDER is deepgram)
 * sends mip_opt_out. TTS_PROVIDER=xai speaks through LiveKit Inference
 * (xai/tts-1) and does not call xAI with our own key. Session recording is
 * off, and logs stay at error level so answers never land in log storage.
 */
import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent, llm, voice } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as silero from "@livekit/agents-plugin-silero";
import { createHmac } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { SPEAKABLE_BUDGET_MS, toSpeakable, type SpeakableRewrite } from "./speech/speakable.js";
import { emptySpeechTotals, noteSpeechMetric } from "./speech-usage.js";
import { selectTts, type TtsChoice } from "./tts.js";

export const AGENT_NAME = "defend-it-interviewer";
const API = (process.env.DEFEND_IT_API_URL || "").replace(/\/$/, "");
const SECRET = process.env.VOICE_AGENT_SECRET || "";

interface Probe {
  id: string;
  type: string;
  question: string;
}
interface Plan {
  difficulty: string;
  probes: Probe[];
  answered: number;
}

async function call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const json = JSON.stringify(body);
  const ts = Date.now();
  const signature = createHmac("sha256", SECRET).update(`${ts}.${json}`).digest("hex");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-defend-timestamp": String(ts), "x-defend-signature": signature },
    body: json,
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw Object.assign(new Error(`${path} failed (${res.status})`), { status: res.status });
  return (await res.json()) as T;
}

function interviewerTts(choice: TtsChoice): string | deepgram.TTS {
  switch (choice.kind) {
    case "deepgram-plugin":
      return new deepgram.TTS({ model: choice.model, mipOptOut: choice.mipOptOut });
    case "deepgram-inference":
      return choice.descriptor;
    case "xai-inference":
      return choice.descriptor;
    default: {
      const _exhaustive: never = choice;
      return _exhaustive;
    }
  }
}

const ACKS = ["Thanks.", "Got it.", "Okay.", "Understood.", "Thank you."];
const REPEAT = /\b(repeat|say (that|it) again|didn'?t (catch|hear)|pardon|come again)\b/i;

/**
 * Optional model paraphrase. The web app owns the model call (zero retention).
 * A miss, a timeout, or a code-like answer falls back to the local rules pass.
 */
function speechRewrite(sessionId: string): SpeakableRewrite | undefined {
  if (process.env.SPEECH_REWRITE_LLM !== "1") return undefined;
  return async (text, signal) => {
    const res = await call<{ spoken?: string }>("/api/voice/agent/speak", { text, sessionId }, signal);
    if (typeof res.spoken !== "string" || !res.spoken.trim()) throw new Error("empty speech rewrite");
    return res.spoken;
  };
}

/** TTS-only transform. The transcript is the original text passed to say(). */
function speakableTtsTransform(sessionId: string): (source: ReadableStream<string>) => ReadableStream<string> {
  const rewrite = speechRewrite(sessionId);
  return (source) => speakableTtsStream(source, rewrite);
}

function speakableTtsStream(
  source: ReadableStream<string>,
  rewrite: SpeakableRewrite | undefined,
): ReadableStream<string> {
  const reader = source.getReader();
  return new ReadableStream<string>({
    async start(controller) {
      let raw = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += value;
        }
        const spoken = await toSpeakable(raw, { rewrite, timeoutMs: SPEAKABLE_BUDGET_MS });
        if (spoken.latencyMs >= 500) {
          console.error(`[interviewer] speech rewrite took ${Math.round(spoken.latencyMs)}ms`);
        }
        controller.enqueue(spoken.text || raw);
        controller.close();
      } catch {
        try {
          if (raw) controller.enqueue(raw);
          controller.close();
        } catch {
          // The stream was already cancelled.
        }
      }
    },
    cancel() {
      return reader.cancel();
    },
  });
}

class Interview {
  index = 0;
  questionEndedAt = new Date();
  answerStartedAt: Date | null = null;
  finished = false;

  constructor(
    private ctx: JobContext,
    private session: voice.AgentSession,
    private sessionId: string,
    private plan: Plan,
  ) {
    this.index = plan.answered;
  }

  get current(): Probe | undefined {
    return this.plan.probes[this.index];
  }

  async publish(data: Record<string, unknown>) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    await this.ctx.room.localParticipant?.publishData(bytes, { reliable: true, topic: "defend" });
  }

  ask(prefix = "") {
    const p = this.current;
    if (!p) return;
    this.answerStartedAt = null;
    void this.publish({ type: "question", index: this.index, total: this.plan.probes.length, probeId: p.id });
    this.session.say(`${prefix}Question ${this.index + 1}. ${p.question}`, { allowInterruptions: true });
  }

  async onAnswer(text: string) {
    const p = this.current;
    const answer = text.trim();
    if (!p || this.finished || !answer) return;
    if (REPEAT.test(answer) && answer.split(/\s+/).length < 10) {
      this.ask("Of course. ");
      return;
    }
    // The answer window for this attempt ends now; the next attempt starts fresh.
    const answerStartedAt = this.answerStartedAt ?? this.questionEndedAt;
    this.answerStartedAt = null;
    const answerEndedAt = new Date();
    let resynced = false;
    try {
      await call("/api/voice/agent/answer", {
        sessionId: this.sessionId,
        probeId: p.id,
        answer,
        questionEndedAt: this.questionEndedAt.toISOString(),
        answerStartedAt: answerStartedAt.toISOString(),
        answerEndedAt: answerEndedAt.toISOString(),
      });
    } catch (e) {
      // 409: the server's position differs (e.g. a reconnect). Resync and carry on.
      if ((e as { status?: number }).status === 409) {
        this.plan = await call<Plan>("/api/voice/agent/plan", { sessionId: this.sessionId }).catch(() => this.plan);
        this.index = this.plan.answered;
        resynced = true;
      } else {
        // Status only: never log what the creator said.
        console.error(`[interviewer] saving an answer failed (${(e as { status?: number }).status ?? "network"})`);
        this.session.say("Sorry, I couldn't save that answer. Could you say it again?", { allowInterruptions: true });
        return;
      }
    }
    if (!resynced) this.index += 1;
    await this.publish({ type: "progress", answered: this.index, total: this.plan.probes.length });

    if (this.current) {
      this.ask(`${ACKS[this.index % ACKS.length]} `);
      return;
    }
    this.finished = true;
    this.session.say("That's every question. Thank you. Your answers are being graded now.", { allowInterruptions: false });
    await this.publish({ type: "done" });
  }
}

class Interviewer extends voice.Agent {
  constructor(private interview: () => Interview | undefined) {
    super({ instructions: "Scripted examiner. Never generate replies." });
  }

  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    await this.interview()?.onAnswer(message.textContent ?? "");
    // Never let the framework generate a reply: the script decides what is said.
    throw new voice.StopResponse();
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const { sessionId } = JSON.parse(ctx.job.metadata || "{}") as { sessionId?: string };
    if (!sessionId || !API || SECRET.length < 32) throw new Error("Interviewer is missing its session or configuration");

    await ctx.connect();
    const plan = await call<Plan>("/api/voice/agent/plan", { sessionId });
    const speech = emptySpeechTotals();
    const sessionStarted = Date.now();
    // Session minutes are the LiveKit bill. STT/TTS seconds are added when metrics arrive.
    ctx.addShutdownCallback(async () => {
      await call("/api/voice/agent/usage", {
        sessionId,
        agentSeconds: (Date.now() - sessionStarted) / 1000,
        sttSeconds: speech.sttSeconds,
        ttsSeconds: speech.ttsSeconds,
      }).catch(() => {});
    });

    let interview: Interview | undefined;
    const session = new voice.AgentSession({
      // Rewrite only the TTS input. say() still forwards the original line,
      // so the live transcript and the on-screen question stay exact.
      ttsTextTransforms: [speakableTtsTransform(sessionId), "filter_markdown", "filter_emoji"],
      vad: ctx.proc.userData.vad as silero.VAD,
      // Our own Deepgram key with mip_opt_out on every request when configured;
      // otherwise LiveKit Inference's Deepgram Nova-3 (LiveKit states zero retention).
      stt: process.env.DEEPGRAM_API_KEY
        ? new deepgram.STT({ model: "nova-3", smartFormat: true, punctuate: true, mipOptOut: true })
        : ("deepgram/nova-3" as const),
      // deepgram (default): Aura-2 Thalia on our key, or LiveKit Inference.
      // xai: Grok TTS through LiveKit Inference. See docs/voice-evaluation.md.
      tts: interviewerTts(selectTts(process.env)),
      // Viva answers include thinking pauses: wait longer before ending a turn.
      turnHandling: { endpointing: { minDelay: 1800, maxDelay: 6000 } },
    });

    const audioClock = Date.now();
    let reportedAudio = false;
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      noteSpeechMetric(speech, ev.metrics);
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (!reportedAudio && ev.newState === "speaking") {
        reportedAudio = true;
        // First speech the creator hears. Failure here must not stop the interview.
        void call("/api/voice/agent/timing", { sessionId, durationMs: Date.now() - audioClock }).catch(() => {});
      }
      if (ev.oldState === "speaking" && ev.newState !== "speaking" && interview) interview.questionEndedAt = new Date();
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === "speaking" && interview && !interview.answerStartedAt) interview.answerStartedAt = new Date();
    });

    await session.start({ agent: new Interviewer(() => interview), room: ctx.room, record: false });
    interview = new Interview(ctx, session, sessionId, plan);

    const total = plan.probes.length;
    if (plan.answered === 0) {
      session.say(
        `Hi, I'm your examiner. I'll ask you ${total} questions about your document. ` +
          "Answer in your own words, take your time, and pause when you've finished. You can ask me to repeat a question.",
        { allowInterruptions: false },
      );
    } else {
      session.say("Welcome back. Let's pick up where we left off.", { allowInterruptions: false });
    }
    interview.ask();
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    logLevel: "error",
  }),
);
