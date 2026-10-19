/**
 * Defend It voice interviewer (LiveKit agent).
 *
 * Scripted on purpose: it asks only the questions our server already wrote
 * for this deliverable, in order, and reports each spoken answer (with timing)
 * back to the server, which grades exactly as for typed answers. No language
 * model runs here, so the document never reaches another model.
 *
 * Privacy: Deepgram STT and TTS run with mip_opt_out on every request, LiveKit
 * session recording is off, and logs are kept at error level so answers never
 * land in log storage.
 */
import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent, llm, voice } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as silero from "@livekit/agents-plugin-silero";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

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

async function call<T>(path: string, body: unknown): Promise<T> {
  const json = JSON.stringify(body);
  const ts = Date.now();
  const signature = createHmac("sha256", SECRET).update(`${ts}.${json}`).digest("hex");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-defend-timestamp": String(ts), "x-defend-signature": signature },
    body: json,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw Object.assign(new Error(`${path} failed (${res.status})`), { status: res.status });
  return (await res.json()) as T;
}

const ACKS = ["Thanks.", "Got it.", "Okay.", "Understood.", "Thank you."];
const REPEAT = /\b(repeat|say (that|it) again|didn'?t (catch|hear)|pardon|come again)\b/i;

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
    const answerEndedAt = new Date();
    let resynced = false;
    try {
      await call("/api/voice/agent/answer", {
        sessionId: this.sessionId,
        probeId: p.id,
        answer,
        questionEndedAt: this.questionEndedAt.toISOString(),
        answerStartedAt: (this.answerStartedAt ?? this.questionEndedAt).toISOString(),
        answerEndedAt: answerEndedAt.toISOString(),
      });
    } catch (e) {
      // 409: the server's position differs (e.g. a reconnect). Resync and carry on.
      if ((e as { status?: number }).status === 409) {
        this.plan = await call<Plan>("/api/voice/agent/plan", { sessionId: this.sessionId }).catch(() => this.plan);
        this.index = this.plan.answered;
        resynced = true;
      } else {
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

    let interview: Interview | undefined;
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      // Our own Deepgram key with mip_opt_out on every request when configured;
      // otherwise LiveKit Inference's Deepgram models (LiveKit states zero retention).
      ...(process.env.DEEPGRAM_API_KEY
        ? {
            stt: new deepgram.STT({ model: "nova-3", smartFormat: true, punctuate: true, mipOptOut: true }),
            tts: new deepgram.TTS({ model: "aura-2-thalia-en", mipOptOut: true }),
          }
        : { stt: "deepgram/nova-3" as const, tts: "deepgram/aura-2" as const }),
      // Viva answers include thinking pauses: wait longer before ending a turn.
      turnHandling: { endpointing: { minDelay: 1800, maxDelay: 6000 } },
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
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
