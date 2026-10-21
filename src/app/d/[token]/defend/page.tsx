"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMe } from "@/components/auth";
import { Companion } from "@/components/companion/Companion";
import { VoiceInterview } from "@/components/voice/VoiceInterview";
import { gradingProgressLabel, type GradingProgress } from "@/lib/grading-progress";
import { canSubmit, INITIAL_INTERVIEW, interviewReducer, type InterviewState } from "@/lib/interview-state";

interface Probe {
  id: string;
  claimId: string;
  type: string;
  question: string;
  plantedContent?: string;
}

export default function DefendPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [channel, setChannel] = useState<"text" | "voice" | "text_accommodation" | null>(null);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [interview, setInterview] = useState<InterviewState>(INITIAL_INTERVIEW);
  const interviewRef = useRef(interview);
  const [answer, setAnswer] = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteEvents, setPasteEvents] = useState(0);
  const [focusBlurEvents, setFocusBlurEvents] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const { me } = useMe();
  const [showName, setShowName] = useState(false);
  const [gradeProgress, setGradeProgress] = useState<GradingProgress | null>(null);
  useEffect(() => {
    if (me?.displayName) setShowName(true);
  }, [me]);

  useEffect(() => {
    const onBlur = () => setFocusBlurEvents((n) => n + 1);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  const dispatch = useCallback((event: Parameters<typeof interviewReducer>[1]) => {
    const next = interviewReducer(interviewRef.current, event);
    interviewRef.current = next;
    setInterview(next);
    return next;
  }, []);

  const begin = useCallback(
    async (accommodation = false) => {
      setError(null);
      try {
        const res = await fetch("/api/sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({ token, mode: "defend", ...(accommodation ? { accommodation: true } : {}) }),
        });
        if (!res.ok) {
          const failed = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(failed.error || "Failed to start");
        }
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("ndjson") || !res.body) {
          const start = (await res.json()) as {
            error?: string;
            probes?: Probe[];
            sessionId?: string;
            channel?: "text" | "voice" | "text_accommodation";
          };
          if (start.error) throw new Error(start.error);
          const nextProbes = start.probes || [];
          setSessionId(start.sessionId ?? null);
          setChannel(start.channel ?? "text");
          setProbes(nextProbes);
          dispatch({ type: "start_ok", total: nextProbes.length });
          setSessionStartedAt(new Date().toISOString());
          return;
        }
        await readNdjson(res.body, (event) => {
          if (event.type === "error") throw new Error(typeof event.error === "string" ? event.error : "Failed to start");
          if (event.type === "question" && event.probe && typeof event.probe === "object") {
            const probe = event.probe as Probe;
            setSessionId(typeof event.sessionId === "string" ? event.sessionId : null);
            setChannel(event.channel === "voice" || event.channel === "text_accommodation" ? event.channel : "text");
            setProbes((prev) => (prev.length > 1 ? prev : [probe]));
            if (interviewRef.current.phase === "starting") {
              dispatch({ type: "start_ok", total: typeof event.total === "number" ? event.total : 1 });
              setSessionStartedAt(new Date().toISOString());
            }
          }
          if (event.type === "text" && typeof event.text === "string") {
            setProbes((prev) => (prev[0] ? [{ ...prev[0], question: prev[0].question + event.text }] : prev));
          }
          if (event.type === "ready" && Array.isArray(event.probes)) {
            const nextProbes = event.probes as Probe[];
            setSessionId(typeof event.sessionId === "string" ? event.sessionId : null);
            setChannel(event.channel === "voice" || event.channel === "text_accommodation" ? event.channel : "text");
            setProbes((prev) => {
              const index = interviewRef.current.index;
              if (index <= 0) return nextProbes;
              return nextProbes.map((probe, i) => (i < index ? (prev[i] ?? probe) : probe));
            });
            if (interviewRef.current.phase === "starting") {
              dispatch({ type: "start_ok", total: nextProbes.length });
              setSessionStartedAt(new Date().toISOString());
            }
          }
        });
      } catch (e) {
        dispatch({ type: "start_fail" });
        setError(e instanceof Error ? e.message : "Failed to start");
      }
    },
    [token, dispatch],
  );

  useEffect(() => {
    // One plan per visit, even when React re-runs effects in development.
    if (startedRef.current) return;
    startedRef.current = true;
    void begin();
  }, [begin]);

  useEffect(() => {
    if (interview.phase !== "grading" || !sessionId) return;
    let stop = false;
    const poll = async () => {
      while (!stop) {
        try {
          const res = await fetch(`/api/sessions/defend/progress?sessionId=${encodeURIComponent(sessionId)}`);
          const data = (await res.json()) as { progress?: GradingProgress | null };
          if (data.progress) setGradeProgress(data.progress);
        } catch {
          // The complete request is the source of truth; a missed poll just keeps the last line.
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [interview.phase, sessionId]);

  const completeDefense = useCallback(async () => {
    if (interviewRef.current.phase !== "grading") {
      const total = interviewRef.current.total;
      dispatch({ type: "saved", answered: total, total });
    }
    try {
      const result = await fetch("/api/sessions/defend/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, pasteEvents, focusBlurEvents, showName }),
      }).then((r) => r.json());
      if (result.followUp?.probe) {
        setProbes((prev) => (prev.some((p) => p.id === result.followUp.probe.id) ? prev : [...prev, result.followUp.probe]));
        dispatch({ type: "follow_up", answered: result.followUp.answered, total: result.followUp.total });
        setError(null);
        return;
      }
      if (result.error) throw new Error(result.error);
      if (!result.receipt?.payload?.id) throw new Error("Grading finished without a receipt. Retry.");
      dispatch({ type: "grade_ok" });
      router.push(`/r/${result.receipt.payload.id}`);
    } catch (e) {
      dispatch({ type: "grade_fail" });
      setError(e instanceof Error ? e.message : "Grading failed");
    }
  }, [sessionId, pasteEvents, focusBlurEvents, showName, router, dispatch]);

  useEffect(() => {
    if (!sessionStartedAt) return;
    tickRef.current = window.setInterval(() => {
      setElapsed(Date.now() - new Date(sessionStartedAt).getTime());
    }, 500);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [sessionStartedAt]);

  const index = interview.index;
  const busy = interview.phase === "saving" || interview.phase === "grading" || interview.phase === "starting";
  const total = Math.max(interview.total, probes.length);
  const current = probes[index];
  const voiceReady = channel === "voice" && total > 0 && probes.length === total;
  const minutes = useMemo(() => {
    const s = Math.floor(elapsed / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, [elapsed]);

  async function submitTurn(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !sessionId || !answer.trim()) return;
    if (!canSubmit(interviewRef.current)) return;
    const resume = interviewRef.current.phase === "follow_up" ? "follow_up" : "answering";
    dispatch({ type: "submit" });
    setError(null);
    try {
      // The server records the answer and its timing; the browser only shows progress.
      const saved = await fetch("/api/sessions/defend/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, probeId: current.id, answer }),
      }).then((r) => r.json());
      if (saved.error) throw new Error(saved.error);
      setAnswer("");
      if (saved.nextProbe?.id) {
        setProbes((prev) => prev.map((probe) => (probe.id === saved.nextProbe.id ? { ...probe, ...saved.nextProbe } : probe)));
      }
      dispatch({ type: "saved", answered: saved.answered, total: saved.total });
      if (saved.done) await completeDefense();
    } catch (err) {
      dispatch({ type: "save_fail", resume });
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function retryGrade() {
    setError(null);
    try {
      await completeDefense();
    } catch (err) {
      dispatch({ type: "grade_fail" });
      setError(err instanceof Error ? err.message : "Grading failed");
    }
  }

  if (interview.phase === "error" || (error && probes.length === 0)) {
    return (
      <div className="shell grid max-w-3xl gap-4">
        <p className="text-danger">{error || "Could not start the interview."}</p>
        <button
          type="button"
          className="btn btn-primary justify-self-start"
          onClick={() => {
            dispatch({ type: "retry" });
            void begin();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (interview.phase === "grading" || interview.phase === "completed") {
    return (
      <div className="shell grid max-w-3xl gap-4">
        <Companion state="thinking" size={72} />
        <p>{gradingProgressLabel(gradeProgress, !!error)}</p>
        {error && <p className="text-sm text-danger">{error}</p>}
        {error && (
          <button type="button" className="btn btn-primary justify-self-start" onClick={() => void retryGrade()}>
            Retry grading
          </button>
        )}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="shell grid max-w-3xl gap-4">
        <Companion state="thinking" size={72} />
        <p>{interview.phase === "starting" ? "Writing questions for your file…" : "Loading…"}</p>
      </div>
    );
  }

  if (voiceReady && sessionId && interview.phase !== "follow_up") {
    return (
      <div className="shell grid max-w-3xl gap-6">
        <div>
          <p className="eyebrow">Defend &middot; live voice interview</p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Live defense</h1>
        </div>
        <VoiceInterview
          sessionId={sessionId}
          probes={probes}
          onComplete={completeDefense}
          onUseText={() => void begin(true)}
        />
        {me?.displayName && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} />
            Show my name ({me.displayName}) on the receipt
          </label>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="shell max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">
            Defend · {channel === "text_accommodation" ? "typed (accommodation)" : "text interview"}
          </p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Live defense</h1>
        </div>
        <div className="text-right text-sm">
          <div>
            Question {index + 1} / {total}
          </div>
          <div className="font-mono">{minutes}</div>
        </div>
      </div>

      <ol className="mt-6 flex gap-1.5" aria-label="Interview progress">
        {Array.from({ length: total }, (_, i) => {
          const p = probes[i];
          return (
          <li
            key={p?.id ?? `pending-${i}`}
            aria-current={i === index ? "step" : undefined}
            className={`h-1.5 flex-1 ${
              i < index ? "bg-[var(--blueprint)]" : i === index ? "bg-[var(--ink)]" : "bg-[var(--line)]"
            }`}
          >
            <span className="sr-only">
              Question {i + 1}
              {i < index ? " answered" : i === index ? " current" : ""}
            </span>
          </li>
          );
        })}
      </ol>

      <div className="panel mt-6 grid gap-5 p-5 sm:p-6">
        <div className="grid grid-cols-[auto_1fr] items-start gap-4">
          <Companion state={busy ? "thinking" : "listening"} size={64} />
          <div className="min-w-0">
            <p
              className={`mono text-xs uppercase tracking-[0.08em] ${
                current.type === "planted_error" ? "text-[var(--signal)]" : "text-[var(--blueprint)]"
              }`}
            >
              Probe {String(index + 1).padStart(2, "0")} &middot; {current.type.replace("_", " ")}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-lg font-semibold leading-relaxed">
              {current.question}
            </p>
            {interview.phase === "follow_up" && (
              <p className="mt-2 text-sm text-[var(--ink-2)]">
                Graders disagreed on the previous answer, so this extra question replaces a guess.
              </p>
            )}
          </div>
        </div>
        <form onSubmit={submitTurn} className="space-y-3">
          <textarea
            className="field min-h-36"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onPaste={() => setPasteEvents((n) => n + 1)}
            placeholder="Answer in your own words. Timing is recorded as a separate integrity signal."
            required
            disabled={busy}
          />
          {index + 1 === total && me?.displayName && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showName}
                onChange={(e) => setShowName(e.target.checked)}
              />
              Show my name ({me.displayName}) on the receipt
            </label>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          {channel === "voice" && (
            <p className="text-sm text-[var(--ink-2)]">Opening the voice interview…</p>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || channel === "voice"}>
            {busy
              ? index + 1 < total
                ? "Saving…"
                : gradingProgressLabel(gradeProgress, false)
              : index + 1 < total
                ? "Submit & next"
                : "Submit & finish"}
          </button>
        </form>
      </div>
    </div>
  );
}

interface StartEvent {
  type?: string;
  error?: unknown;
  sessionId?: unknown;
  channel?: unknown;
  total?: unknown;
  text?: unknown;
  probe?: unknown;
  probes?: unknown;
}

/** Read a newline-delimited JSON response, handing each object to the caller as it arrives. */
async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (event: StartEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as StartEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as StartEvent);
}
