"use client";

import { ConnectionState, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Companion, type CompanionState } from "@/components/companion/Companion";

interface Probe {
  id: string;
  type: string;
  question: string;
}

type Phase = "ready" | "connecting" | "live" | "grading" | "error";

/**
 * Live voice defense. The interviewer agent (agent/) joins the LiveKit room,
 * reads each question aloud and records answers on the server. This panel
 * shows the question, live captions and progress, and hands off to grading
 * when the agent says it is done. Audio is never stored.
 */
export function VoiceInterview({
  sessionId,
  probes,
  onComplete,
  onUseText,
}: {
  sessionId: string;
  probes: Probe[];
  onComplete: () => Promise<void>;
  onUseText: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [index, setIndex] = useState(0);
  const [answered, setAnswered] = useState(0);
  const [agentState, setAgentState] = useState("initializing");
  const [caption, setCaption] = useState<{ who: "examiner" | "you"; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    setPhase("grading");
    // Let the closing line play, then leave the room and grade.
    await new Promise((r) => setTimeout(r, 3500));
    await roomRef.current?.disconnect();
    try {
      await onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grading failed");
      setPhase("error");
      finishing.current = false;
    }
  }, [onComplete]);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  async function start() {
    setPhase("connecting");
    setError(null);
    try {
      const res = await fetch("/api/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not start the voice interview");

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) audioRef.current?.appendChild(track.attach());
      });
      room.on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, p) => {
        if ((p as RemoteParticipant).isAgent && changed["lk.agent.state"]) setAgentState(changed["lk.agent.state"]);
      });
      room.on(RoomEvent.DataReceived, (payload: Uint8Array, _p, _k, topic?: string) => {
        if (topic !== "defend") return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload)) as { type: string; index?: number; answered?: number };
          if (msg.type === "question" && typeof msg.index === "number") setIndex(msg.index);
          if (msg.type === "progress" && typeof msg.answered === "number") setAnswered(msg.answered);
          if (msg.type === "done") void finish();
        } catch {}
      });
      room.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
        const who = participant.identity === room.localParticipant.identity ? "you" : "examiner";
        let text = "";
        for await (const chunk of reader) {
          text += chunk;
          setCaption({ who, text });
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        if (!finishing.current) setPhase((p) => (p === "live" ? "error" : p));
      });

      await room.connect(j.url, j.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (room.state === ConnectionState.Connected) setPhase("live");
      // If no interviewer joins, say so instead of leaving the creator in silence.
      setTimeout(() => {
        const hasAgent = [...room.remoteParticipants.values()].some((p) => p.isAgent);
        if (!hasAgent && room.state === ConnectionState.Connected && !finishing.current) {
          setError("The interviewer didn't join. Try again in a moment, or answer in writing below.");
          setPhase("error");
          void room.disconnect();
        }
      }, 20_000);
    } catch (e) {
      setError(
        e instanceof Error && /permission|denied|NotAllowed/i.test(e.message)
          ? "Microphone access was blocked. Allow it in your browser, or use the typed option below."
          : e instanceof Error
            ? e.message
            : "Could not start the voice interview",
      );
      setPhase("error");
      await roomRef.current?.disconnect();
    }
  }

  const companion: CompanionState =
    phase === "grading" ? "thinking" : agentState === "thinking" ? "thinking" : agentState === "speaking" ? "speaking" : "listening";
  const total = probes.length;
  const current = probes[Math.min(index, total - 1)];

  return (
    <div className="grid gap-5">
      <ol className="flex gap-1.5" aria-label="Interview progress">
        {probes.map((p, i) => (
          <li
            key={p.id}
            className={`h-1.5 flex-1 ${i < answered ? "bg-[var(--blueprint)]" : i === index && phase === "live" ? "bg-[var(--ink)]" : "bg-[var(--line)]"}`}
          >
            <span className="sr-only">Question {i + 1}{i < answered ? " answered" : ""}</span>
          </li>
        ))}
      </ol>

      <div className="panel grid gap-5 p-5 sm:p-6">
        <div className="grid grid-cols-[auto_1fr] items-start gap-4">
          <Companion state={companion} size={84} />
          <div className="min-w-0">
            {phase === "ready" || phase === "connecting" ? (
              <>
                <p className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Live voice interview</p>
                <p className="mt-2 text-lg font-semibold">
                  The examiner will ask {total} questions out loud. Answer in your own words and pause when you&apos;re done.
                </p>
                <p className="mt-2 text-sm text-[var(--ink-2)]">
                  Your answers are transcribed to grade them; the audio is never stored. Use headphones if you can.
                </p>
              </>
            ) : (
              <>
                <p className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">
                  Question {Math.min(index + 1, total)} of {total}
                </p>
                <p className="mt-2 text-lg font-semibold">{current?.question}</p>
              </>
            )}
          </div>
        </div>

        {phase === "live" && (
          <div className="min-h-[3.5rem] border-t-[1.5px] border-[var(--ink)] pt-3" aria-live="polite">
            {caption ? (
              <p className="text-sm">
                <span className="mono mr-2 text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">{caption.who}</span>
                {caption.text}
              </p>
            ) : (
              <p className="text-sm text-[var(--ink-2)]">Captions appear here.</p>
            )}
          </div>
        )}

        {(phase === "ready" || phase === "connecting") && (
          <button type="button" className="btn btn-primary justify-self-start" onClick={start} disabled={phase === "connecting"}>
            {phase === "connecting" ? "Connecting…" : "Start voice interview"}
          </button>
        )}
        {phase === "live" && (
          <p className="mono text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">
            {agentState === "speaking" ? "Examiner speaking" : agentState === "thinking" ? "Saving your answer" : "Listening to you"}
          </p>
        )}
        {phase === "grading" && <p className="font-semibold">Grading your defense…</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        {phase === "error" && (
          <button type="button" className="btn btn-ghost justify-self-start" onClick={start}>
            Try again
          </button>
        )}
        <div ref={audioRef} hidden />
      </div>

      {phase !== "grading" && (
        <p className="text-sm text-[var(--ink-2)]">
          Can&apos;t use your voice for this interview?{" "}
          <button type="button" className="text-[var(--blueprint)] underline" onClick={onUseText}>
            Answer in writing instead
          </button>
          . The receipt will note it was a typed accommodation.
        </p>
      )}
    </div>
  );
}
