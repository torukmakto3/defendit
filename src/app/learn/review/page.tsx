"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SignInCard, useMe } from "@/components/auth";
import { Companion, type CompanionState } from "@/components/companion/Companion";

interface Card {
  id: string;
  front: string;
  back: string;
  source: string | null;
}

type RatingName = "again" | "hard" | "good" | "easy";
const RATINGS: { key: RatingName; label: string; hint: string; shortcut: string }[] = [
  { key: "again", label: "Again", hint: "Didn't recall", shortcut: "1" },
  { key: "hard", label: "Hard", hint: "Recalled with effort", shortcut: "2" },
  { key: "good", label: "Good", hint: "Recalled", shortcut: "3" },
  { key: "easy", label: "Easy", hint: "Instant", shortcut: "4" },
];

export default function ReviewPage() {
  const { me } = useMe();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [mood, setMood] = useState<CompanionState>("listening");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    const project = new URLSearchParams(window.location.search).get("project");
    fetch(`/api/learn/cards${project ? `?token=${encodeURIComponent(project)}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Could not load cards");
        setCards(j.cards);
      })
      .catch((e) => setError(e.message));
  }, [me]);

  const current = cards?.[0];

  const rate = useCallback(
    async (rating: RatingName) => {
      if (!current) return;
      setMood(rating === "again" ? "skeptical" : rating === "easy" ? "surprised" : "listening");
      try {
        const res = await fetch("/api/learn/cards/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId: current.id, rating }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "Could not save");
        setCards((cs) => (cs ? cs.slice(1) : cs));
        setDone((n) => n + 1);
        setRevealed(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save");
      }
    },
    [current],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      const r = RATINGS.find((x) => x.shortcut === e.key);
      if (revealed && r) void rate(r.key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, rate]);

  const remaining = cards?.length ?? 0;

  return (
    <div className="shell grid max-w-2xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="eyebrow">Learn &middot; flashcards</span>
          <h1 className="text-3xl font-bold">Review</h1>
        </div>
        <span className="mono text-sm text-[var(--ink-2)]">
          {done} done &middot; {remaining} left
        </span>
      </div>

      {me === null && <SignInCard title="Sign in to review your cards" />}
      {error && <p className="text-sm text-danger">{error}</p>}

      {me && cards === null && !error && (
        <div className="panel grid gap-3 p-6" aria-busy="true">
          <span className="block h-5 w-3/4 animate-pulse bg-[var(--line)]" />
          <span className="block h-5 w-1/2 animate-pulse bg-[var(--line)]" />
          <p className="text-sm text-[var(--ink-2)]">Loading cards…</p>
        </div>
      )}

      {me && cards && !current && (
        <div className="panel grid justify-items-center gap-3 p-8 text-center">
          <Companion state="impressed" size={84} />
          <p className="text-lg font-semibold">All caught up.</p>
          <p className="text-[var(--ink-2)]">Cards come back when they&apos;re due, spaced so they stick.</p>
          <Link href="/learn" className="btn btn-ghost">
            Back to projects
          </Link>
        </div>
      )}

      {me && current && (
        <div className="panel grid gap-5 p-5 sm:p-6">
          <div className="grid grid-cols-[auto_1fr] items-start gap-4">
            <Companion state={revealed ? mood : "listening"} size={64} />
            <div className="min-w-0">
              <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Question</span>
              <p className="mt-1 text-lg font-semibold" aria-live="polite">{current.front}</p>
            </div>
          </div>

          {revealed ? (
            <>
              <div className="border-t-[1.5px] border-[var(--ink)] pt-4">
                <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">Answer</span>
                <p className="mt-1">{current.back}</p>
              </div>
              {current.source && (
                <div>
                  <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">Source</span>
                  <p className="mt-1 text-sm text-[var(--ink-2)]">{current.source}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="How well did you recall it?">
                {RATINGS.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    className={r.key === "good" ? "btn btn-primary" : "btn btn-ghost"}
                    onClick={() => rate(r.key)}
                    aria-keyshortcuts={r.shortcut}
                  >
                    <span className="grid text-center leading-tight">
                      <span>{r.label}</span>
                      <span className="mono text-[10px] font-normal opacity-80">{r.hint} &middot; {r.shortcut}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button type="button" className="btn btn-primary justify-self-start" onClick={() => setRevealed(true)}>
              Show answer <span className="mono ml-2 text-[10px] opacity-80">space</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
