"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface GapItem {
  section: string;
  strength: string;
  note: string;
}

export default function LearnPage() {
  const { token } = useParams<{ token: string }>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [coachMessage, setCoachMessage] = useState("Starting private coach…");
  const [answer, setAnswer] = useState("");
  const [gaps, setGaps] = useState<GapItem[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setBusy(true);
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
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(false);
      }
    })();
  }, [token]);

  async function submitAnswer(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || !answer.trim()) return;
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
      setDone(Boolean(turn.done));
      setAnswer("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell max-w-3xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.12em] text-[var(--leaf)]">
            Learn · private
          </p>
          <h1 className="mt-2 text-4xl text-[var(--moss)]">Socratic coach</h1>
        </div>
        <Link href={`/d/${token}/defend`} className="btn btn-primary">
          Ready to Defend
        </Link>
      </div>

      <div className="panel mt-8 rounded-xl p-6">
        <p className="text-lg leading-relaxed">{coachMessage}</p>
        {!done && (
          <form onSubmit={submitAnswer} className="mt-6 space-y-3">
            <textarea
              className="field min-h-28"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Explain in your own words…"
              disabled={busy}
            />
            {error && <p className="text-sm text-red-700">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Thinking…" : "Reply"}
            </button>
          </form>
        )}
        {done && (
          <p className="mt-6 text-sm text-[var(--leaf)]">
            Prep complete. Your gap map is below — nothing from Learn is shared.
          </p>
        )}
      </div>

      <div className="mt-8">
        <h2 className="text-2xl text-[var(--moss)]">Gap map</h2>
        {gaps.length === 0 ? (
          <p className="mt-2 text-sm text-[color-mix(in_srgb,var(--ink)_60%,transparent)]">
            Gaps appear as you answer.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {gaps.map((g, i) => (
              <li key={`${g.section}-${i}`} className="panel rounded-lg px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <strong>{g.section}</strong>
                  <span className="text-xs uppercase tracking-wide text-[var(--amber)]">
                    {g.strength}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
                  {g.note}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
