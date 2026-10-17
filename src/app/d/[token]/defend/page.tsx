"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

interface Probe {
  id: string;
  claimId: string;
  type: string;
  question: string;
  plantedContent?: string;
}

interface Turn {
  id: string;
  probeId: string;
  question: string;
  answer: string;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  followUpIndex: number;
}

export default function DefendPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [questionStartedAt, setQuestionStartedAt] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteEvents, setPasteEvents] = useState(0);
  const [focusBlurEvents, setFocusBlurEvents] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    const onBlur = () => setFocusBlurEvents((n) => n + 1);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  useEffect(() => {
    const raw = sessionStorage.getItem(`defend-it:${token}:creator`);
    const creator = raw
      ? (JSON.parse(raw) as { creatorName: string; creatorEmail: string })
      : { creatorName: "Ana Analyst", creatorEmail: "ana@fund.example" };

    (async () => {
      setBusy(true);
      try {
        const start = await fetch("/api/sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, mode: "defend", ...creator }),
        }).then((r) => r.json());
        if (start.error) throw new Error(start.error);
        setSessionId(start.sessionId);
        setProbes(start.probes || []);
        const now = new Date().toISOString();
        setSessionStartedAt(now);
        setQuestionStartedAt(now);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to start");
      } finally {
        setBusy(false);
      }
    })();
  }, [token]);

  useEffect(() => {
    if (!sessionStartedAt) return;
    tickRef.current = window.setInterval(() => {
      setElapsed(Date.now() - new Date(sessionStartedAt).getTime());
    }, 500);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [sessionStartedAt]);

  const current = probes[index];
  const minutes = useMemo(() => {
    const s = Math.floor(elapsed / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, [elapsed]);

  async function submitTurn(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !questionStartedAt || !sessionId) return;
    const endedAt = new Date().toISOString();
    const latencyMs = Date.now() - new Date(questionStartedAt).getTime();
    const turn: Turn = {
      id: `turn_${index + 1}`,
      probeId: current.id,
      question: current.question,
      answer,
      startedAt: questionStartedAt,
      endedAt,
      latencyMs,
      followUpIndex: 0,
    };
    const nextTurns = [...turns, turn];
    setTurns(nextTurns);
    setAnswer("");

    if (index + 1 < probes.length) {
      setIndex(index + 1);
      setQuestionStartedAt(new Date().toISOString());
      return;
    }

    setBusy(true);
    try {
      const result = await fetch("/api/sessions/defend/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          turns: nextTurns,
          pasteEvents,
          focusBlurEvents,
        }),
      }).then((r) => r.json());
      if (result.error) throw new Error(result.error);
      router.push(`/r/${result.receipt.payload.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grading failed");
      setBusy(false);
    }
  }

  if (error && probes.length === 0) {
    return (
      <div className="shell">
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="shell">
        <p>{busy ? "Preparing interview plan…" : "Loading…"}</p>
      </div>
    );
  }

  return (
    <div className="shell max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm uppercase tracking-[0.12em] text-[var(--leaf)]">
            Defend · text interview
          </p>
          <h1 className="mt-2 text-4xl text-[var(--moss)]">Live defense</h1>
        </div>
        <div className="text-right text-sm">
          <div>
            Question {index + 1} / {probes.length}
          </div>
          <div className="font-mono">{minutes}</div>
        </div>
      </div>

      <div className="panel mt-8 rounded-xl p-6">
        <p className="text-xs uppercase tracking-wide text-[var(--amber)]">
          {current.type.replace("_", " ")}
        </p>
        <p className="mt-3 whitespace-pre-wrap text-lg leading-relaxed">
          {current.question}
        </p>
        <form onSubmit={submitTurn} className="mt-6 space-y-3">
          <textarea
            className="field min-h-36"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onPaste={() => setPasteEvents((n) => n + 1)}
            placeholder="Answer in your own words. Timing is recorded as an integrity signal."
            required
            disabled={busy}
          />
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy
              ? "Grading council scoring…"
              : index + 1 < probes.length
                ? "Submit & next"
                : "Submit & finish"}
          </button>
        </form>
      </div>
      <p className="mt-4 text-xs text-[color-mix(in_srgb,var(--ink)_55%,transparent)]">
        Voice providers (ElevenLabs Agents / OpenAI Realtime) plug into{" "}
        <code>src/lib/voice</code>. This build ships a solid text path.
      </p>
    </div>
  );
}
