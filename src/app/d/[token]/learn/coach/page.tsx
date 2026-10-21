"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Companion, type CompanionState } from "@/components/companion/Companion";

interface GapItem {
  section: string;
  strength: string;
  note: string;
}

export default function LearnCoachPage() {
  const { token } = useParams<{ token: string }>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [coachMessage, setCoachMessage] = useState("Starting private coach…");
  const [answer, setAnswer] = useState("");
  const [gaps, setGaps] = useState<GapItem[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reaction, setReaction] = useState<string | null>(null);
  const startedRef = useRef(false);
  const sendingRef = useRef(false);

  const boot = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const start = await fetch("/api/sessions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, mode: "learn" }),
      }).then((r) => r.json());
      if (start.error) throw new Error(start.error);
      setSessionId(start.sessionId);
      const turn = await fetch("/api/sessions/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: start.sessionId }),
      }).then((r) => r.json());
      if (turn.error) throw new Error(turn.error);
      setCoachMessage(turn.coachMessage);
      setGaps(turn.gaps || []);
      setReaction(turn.gapHint?.strength ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void boot();
  }, [boot]);

  async function submitAnswer(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || !answer.trim() || sendingRef.current) return;
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const turn = await fetch("/api/sessions/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer }),
      }).then((r) => r.json());
      if (turn.error) throw new Error(turn.error);
      setCoachMessage(turn.coachMessage);
      setGaps(turn.gaps || []);
      setReaction(turn.gapHint?.strength ?? null);
      setDone(Boolean(turn.done));
      setAnswer("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  const companionState: CompanionState = busy
    ? "thinking"
    : answer.trim()
      ? "listening"
      : reaction === "strong"
        ? "surprised"
        : reaction === "weak"
          ? "skeptical"
          : "listening";

  return (
    <div className="shell max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Learn · coach</p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Talk it through</h1>
        </div>
        <Link href={`/d/${token}/learn`} className="btn btn-ghost">
          Back to flashcards
        </Link>
      </div>

      <div className="panel mt-8 grid gap-5 p-5 sm:p-6">
        <div className="grid grid-cols-[auto_1fr] items-start gap-4">
          <Companion state={companionState} size={64} />
          <p className="min-w-0 text-lg leading-relaxed" aria-live="polite">
            {coachMessage}
          </p>
        </div>
        {!done && (
          <form onSubmit={submitAnswer} className="space-y-3">
            <textarea
              className="field min-h-28"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Explain in your own words…"
              disabled={busy}
            />
            {error && (
              <p className="text-sm text-danger">
                {error}{" "}
                {!sessionId && (
                  <button type="button" className="underline" onClick={() => void boot()}>
                    Try again
                  </button>
                )}
              </p>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Thinking…" : "Reply"}
            </button>
          </form>
        )}
        {done && (
          <p className="text-sm text-[var(--ok)]">
            Prep complete. Your gap map is below. Nothing from Learn is shared.
          </p>
        )}
      </div>

      <div className="mt-8">
        <h2 className="text-2xl font-bold">Gap map</h2>
        {gaps.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--ink-2)]">Gaps appear as you answer.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {gaps.map((gap, i) => (
              <li key={`${gap.section}-${i}`} className="panel px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <strong>{gap.section}</strong>
                  <span
                    className={`mono text-xs uppercase tracking-[0.08em] ${
                      gap.strength === "strong"
                        ? "text-[var(--ok)]"
                        : gap.strength === "weak"
                          ? "text-[var(--signal)]"
                          : "text-[var(--ink-2)]"
                    }`}
                  >
                    {gap.strength}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-2)]">{gap.note}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
