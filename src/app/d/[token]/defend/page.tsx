"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMe } from "@/components/auth";
import { Companion } from "@/components/companion/Companion";
import { VoiceInterview } from "@/components/voice/VoiceInterview";
import { gradingProgressLabel, type GradingProgress } from "@/lib/grading-progress";
import { canSubmit, INITIAL_INTERVIEW, interviewReducer, withProbeAt, type InterviewState } from "@/lib/interview-state";

interface Probe {
  id: string;
  claimId: string;
  type: string;
  question: string;
  plantedContent?: string;
}

interface DefendState {
  sessionId: string;
  channel: "text" | "voice" | "text_accommodation";
  status: string;
  answered: number;
  total: number;
  probes: Probe[];
  progress: GradingProgress | null;
  receiptId: string | null;
  startedAt: string;
  pasteEvents: number;
  focusBlurEvents: number;
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
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const pasteRef = useRef(0);
  const focusRef = useRef(0);
  const showNameRef = useRef(false);
  /** Set when a reload found a grade still claimed, so a released claim can offer retry. */
  const watchGradingRelease = useRef(false);
  const { me } = useMe();
  const [showName, setShowName] = useState(false);
  const [gradeProgress, setGradeProgress] = useState<GradingProgress | null>(null);
  useEffect(() => {
    showNameRef.current = showName;
  }, [showName]);
  useEffect(() => {
    if (me?.displayName) setShowName(true);
  }, [me]);

  const flushSignals = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    void fetch("/api/sessions/defend/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: id,
        pasteEvents: pasteRef.current,
        focusBlurEvents: focusRef.current,
      }),
    }).catch(() => {
      // The next answer and the completion send the same totals.
    });
  }, []);

  const notePaste = useCallback(() => {
    pasteRef.current += 1;
    flushSignals();
  }, [flushSignals]);

  const noteFocus = useCallback(() => {
    focusRef.current += 1;
    flushSignals();
  }, [flushSignals]);

  useEffect(() => {
    const onBlur = () => noteFocus();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [noteFocus]);

  const dispatch = useCallback((event: Parameters<typeof interviewReducer>[1]) => {
    const next = interviewReducer(interviewRef.current, event);
    interviewRef.current = next;
    setInterview(next);
    return next;
  }, []);

  const rememberSession = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setSessionId(id);
  }, []);

  const begin = useCallback(
    async (accommodation = false) => {
      setError(null);
      // A new session must not keep the previous plan. Voice falling back to
      // typing used to submit the spoken session's probe ids.
      setProbes([]);
      setChannel(null);
      rememberSession(null);
      pasteRef.current = 0;
      focusRef.current = 0;
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
            startedAt?: string;
          };
          if (start.error) throw new Error(start.error);
          const nextProbes = start.probes || [];
          rememberSession(start.sessionId ?? null);
          setChannel(readChannel(start.channel));
          setProbes(nextProbes);
          dispatch({ type: "start_ok", total: nextProbes.length });
          const started = readStartedAt(start.startedAt);
          if (started) setSessionStartedAt(started);
          return;
        }
        await readNdjson(res.body, (event) => {
          if (event.type === "error") throw new Error(typeof event.error === "string" ? event.error : "Failed to start");
          if (event.type === "question" && event.probe && typeof event.probe === "object") {
            const probe = event.probe as Probe;
            const nextId = typeof event.sessionId === "string" ? event.sessionId : null;
            const switched = nextId !== null && nextId !== sessionIdRef.current;
            rememberSession(nextId);
            setChannel(readChannel(event.channel));
            setProbes((prev) => (switched || prev.length <= 1 ? [probe] : prev));
            if (switched || interviewRef.current.phase === "starting") {
              dispatch({ type: "start_ok", total: typeof event.total === "number" ? event.total : 1 });
              const started = readStartedAt(event.startedAt);
              if (started) setSessionStartedAt(started);
            }
          }
          if (event.type === "text" && typeof event.text === "string") {
            setProbes((prev) => (prev[0] ? [{ ...prev[0], question: prev[0].question + event.text }] : prev));
          }
          if (event.type === "ready" && Array.isArray(event.probes)) {
            const nextProbes = event.probes as Probe[];
            rememberSession(typeof event.sessionId === "string" ? event.sessionId : null);
            setChannel(readChannel(event.channel));
            setProbes((prev) => {
              const index = interviewRef.current.index;
              if (index <= 0) return nextProbes;
              return nextProbes.map((probe, i) => (i < index ? (prev[i] ?? probe) : probe));
            });
            if (interviewRef.current.phase === "starting") {
              dispatch({ type: "start_ok", total: nextProbes.length });
              const started = readStartedAt(event.startedAt);
              if (started) setSessionStartedAt(started);
            }
          }
        });
        if (interviewRef.current.phase === "starting") {
          throw new Error("Failed to start");
        }
      } catch (e) {
        dispatch({ type: "start_fail" });
        setError(e instanceof Error ? e.message : "Failed to start");
      }
    },
    [token, dispatch, rememberSession],
  );

  const completeDefense = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) throw new Error("Grading failed");
    if (interviewRef.current.phase !== "grading") {
      const total = interviewRef.current.total;
      dispatch({ type: "saved", answered: total, total });
    }
    try {
      const result = await fetch("/api/sessions/defend/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: id,
          pasteEvents: pasteRef.current,
          focusBlurEvents: focusRef.current,
          showName: showNameRef.current,
        }),
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
      const challenge = result.challenge as { slug?: string; needsChoice?: boolean } | null | undefined;
      router.push(
        challenge?.needsChoice && challenge.slug
          ? `/c/${challenge.slug}/publish`
          : `/r/${result.receipt.payload.id}`,
      );
    } catch (e) {
      dispatch({ type: "grade_fail" });
      setError(e instanceof Error ? e.message : "Grading failed");
    }
  }, [router, dispatch]);

  const applyState = useCallback(
    (state: DefendState) => {
      rememberSession(state.sessionId);
      setChannel(readChannel(state.channel));
      setProbes(state.probes);
      pasteRef.current = positiveCount(state.pasteEvents);
      focusRef.current = positiveCount(state.focusBlurEvents);
      if (state.startedAt) setSessionStartedAt(state.startedAt);
      setError(null);
      setAnswer("");
      if (state.progress) setGradeProgress(state.progress);
      if (state.status === "completed" && state.receiptId) {
        dispatch({ type: "grade_ok" });
        router.push(`/r/${state.receiptId}`);
        return;
      }
      if (state.answered >= state.total || state.status === "grading") {
        dispatch({ type: "resume_grading", total: state.total });
        watchGradingRelease.current = state.status === "grading";
        if (state.status === "in_progress") void completeDefense();
        return;
      }
      watchGradingRelease.current = false;
      dispatch({ type: "resume", index: state.answered, total: state.total });
    },
    [rememberSession, dispatch, router, completeDefense],
  );

  const resumeOrBegin = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/sessions/defend/state?token=${encodeURIComponent(token)}`, { cache: "no-store" });
      if (res.status === 404) {
        await begin();
        return;
      }
      const body = (await res.json()) as DefendState & { error?: string };
      if (!res.ok) throw new Error(body.error || "Could not resume the interview");
      applyState(body);
    } catch (e) {
      dispatch({ type: "start_fail" });
      setError(e instanceof Error ? e.message : "Could not resume the interview");
    }
  }, [token, begin, applyState, dispatch]);

  useEffect(() => {
    // One plan per visit, even when React re-runs effects in development.
    if (startedRef.current) return;
    startedRef.current = true;
    void resumeOrBegin();
  }, [resumeOrBegin]);

  useEffect(() => {
    if (interview.phase !== "grading" || !sessionId) return;
    let stop = false;
    const poll = async () => {
      while (!stop) {
        try {
          const res = await fetch(`/api/sessions/defend/progress?sessionId=${encodeURIComponent(sessionId)}`);
          const data = (await res.json()) as {
            status?: string;
            progress?: GradingProgress | null;
            receiptId?: string | null;
          };
          if (data.progress) setGradeProgress(data.progress);
          if (data.status === "completed" && data.receiptId) {
            stop = true;
            dispatch({ type: "grade_ok" });
            router.push(`/r/${data.receiptId}`);
            return;
          }
          if (watchGradingRelease.current && data.status === "in_progress") {
            watchGradingRelease.current = false;
            setError("Grading didn't finish.");
          }
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
  }, [interview.phase, sessionId, dispatch, router]);

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
        body: JSON.stringify({
          sessionId,
          probeId: current.id,
          answer,
          pasteEvents: pasteRef.current,
          focusBlurEvents: focusRef.current,
        }),
      }).then((r) => r.json());
      if (saved.error) throw new Error(saved.error);
      setAnswer("");
      const nextProbe = saved.nextProbe as Probe | undefined;
      if (nextProbe?.id) {
        const answered = typeof saved.answered === "number" ? saved.answered : 0;
        setProbes((prev) => withProbeAt(prev, nextProbe, answered));
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
            void resumeOrBegin();
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
        <div>
          <p className="eyebrow">Defend · text interview</p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Live defense</h1>
        </div>
        <div className="panel grid gap-4 p-5 sm:p-6" aria-busy="true">
          <div className="grid grid-cols-[auto_1fr] items-start gap-4">
            <Companion state="thinking" size={64} />
            <div className="grid min-w-0 gap-2">
              <p className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Question</p>
              <span className="block h-5 w-4/5 animate-pulse bg-[var(--line)]" />
              <span className="block h-5 w-2/3 animate-pulse bg-[var(--line)]" />
            </div>
          </div>
          <p className="text-sm text-[var(--ink-2)]">
            {interview.phase === "starting" ? "Writing the first question…" : "Loading…"}
          </p>
        </div>
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
            onPaste={notePaste}
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

function readChannel(value: unknown): "text" | "voice" | "text_accommodation" {
  return value === "voice" || value === "text_accommodation" ? value : "text";
}

interface StartEvent {
  type?: string;
  error?: unknown;
  sessionId?: unknown;
  channel?: unknown;
  total?: unknown;
  startedAt?: unknown;
  text?: unknown;
  probe?: unknown;
  probes?: unknown;
}

function readStartedAt(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function positiveCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(10_000, Math.floor(value)) : 0;
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
