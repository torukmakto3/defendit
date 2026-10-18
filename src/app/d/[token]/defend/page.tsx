"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMe } from "@/components/auth";
import { Companion } from "@/components/companion/Companion";

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
  const [probes, setProbes] = useState<Probe[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteEvents, setPasteEvents] = useState(0);
  const [focusBlurEvents, setFocusBlurEvents] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const { me } = useMe();
  const [showName, setShowName] = useState(false);
  useEffect(() => {
    if (me?.displayName) setShowName(true);
  }, [me]);

  useEffect(() => {
    const onBlur = () => setFocusBlurEvents((n) => n + 1);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  useEffect(() => {
    // One plan per visit, even when React re-runs effects in development.
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      setBusy(true);
      try {
        const start = await fetch("/api/sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, mode: "defend" }),
        }).then((r) => r.json());
        if (start.error) throw new Error(start.error);
        setSessionId(start.sessionId);
        setProbes(start.probes || []);
        const now = new Date().toISOString();
        setSessionStartedAt(now);
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
    if (!current || !sessionId || !answer.trim()) return;
    setBusy(true);
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

      if (!saved.done) {
        setIndex(index + 1);
        setBusy(false);
        return;
      }

      const result = await fetch("/api/sessions/defend/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, pasteEvents, focusBlurEvents, showName }),
      }).then((r) => r.json());
      if (result.error) throw new Error(result.error);
      router.push(`/r/${result.receipt.payload.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  if (error && probes.length === 0) {
    return (
      <div className="shell">
        <p className="text-danger">{error}</p>
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
          <p className="eyebrow">
            Defend · text interview
          </p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Live defense</h1>
        </div>
        <div className="text-right text-sm">
          <div>
            Question {index + 1} / {probes.length}
          </div>
          <div className="font-mono">{minutes}</div>
        </div>
      </div>

      <ol className="mt-6 flex gap-1.5" aria-label="Interview progress">
        {probes.map((p, i) => (
          <li
            key={p.id}
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
        ))}
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
          {index + 1 === probes.length && me?.displayName && (
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
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy
              ? index + 1 < probes.length
                ? "Saving…"
                : "Grading council scoring…"
              : index + 1 < probes.length
                ? "Submit & next"
                : "Submit & finish"}
          </button>
        </form>
      </div>
    </div>
  );
}
