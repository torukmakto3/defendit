"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Companion, type CompanionState } from "@/components/companion/Companion";
import { StudyReupload } from "@/components/study-reupload";
import {
  DEFAULT_LEARN_MODE,
  LEARN_MODES,
  learnMode,
  learnModeStatus,
  type LearnModeId,
} from "@/lib/learn-modes";
import { isStudyFileMissing, STUDY_FILE_DELETED } from "@/lib/study-file";

interface StudyCard {
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

async function requestDeck(token: string, regenerate: boolean): Promise<StudyCard[]> {
  const made = await fetch("/api/learn/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, regenerate }),
  });
  const madeBody = await made.json();
  if (!made.ok) throw new Error(madeBody.error || "Could not make flashcards");
  const res = await fetch(`/api/learn/cards?token=${encodeURIComponent(token)}`, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Could not load cards");
  return body.cards as StudyCard[];
}

export default function LearnPage() {
  const { token } = useParams<{ token: string }>();
  const [mode, setMode] = useState<LearnModeId>(DEFAULT_LEARN_MODE);
  const [title, setTitle] = useState("Your file");
  const [status, setStatus] = useState<string | null>(null);
  const [documentAvailable, setDocumentAvailable] = useState<boolean | null>(null);
  const [cards, setCards] = useState<StudyCard[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (regenerate = false) => {
      setBusy(true);
      setError(null);
      setRevealed(false);
      try {
        const next = await requestDeck(token, regenerate);
        setCards(next);
        if (regenerate) setDone(0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load cards");
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  useEffect(() => {
    let cancelled = false;
    requestDeck(token, false)
      .then((next) => {
        if (!cancelled) setCards(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load cards");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/requests/${token}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (cancelled || !res.ok) return;
        if (typeof body.title === "string" && body.title) setTitle(body.title);
        if (typeof body.status === "string") setStatus(body.status);
        if (typeof body.deliverable?.documentAvailable === "boolean") {
          setDocumentAvailable(body.deliverable.documentAvailable);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  const current = cards?.[0];

  const rate = useCallback(
    async (rating: RatingName) => {
      if (!current) return;
      try {
        const res = await fetch("/api/learn/cards/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId: current.id, rating }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Could not save");
        setCards((list) => (list ? list.slice(1) : list));
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
      if (mode !== "flashcards") return;
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      const rating = RATINGS.find((item) => item.shortcut === e.key);
      if (revealed && rating) void rate(rating.key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, revealed, rate]);

  const companion: CompanionState = busy ? "thinking" : revealed ? "listening" : "listening";
  const remaining = cards?.length ?? 0;
  const fileMissing = isStudyFileMissing(error) && cards === null;

  return (
    <div className="shell grid max-w-2xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <span className="eyebrow">Learn · private</span>
          <h1 className="text-3xl font-bold [overflow-wrap:anywhere]">{title}</h1>
        </div>
        {status === "defended" ? (
          <Link href="/dashboard" className="btn btn-ghost">
            Dashboard
          </Link>
        ) : (
          <Link href={`/d/${token}/defend`} className="btn btn-ghost">
            Ready to Defend
          </Link>
        )}
      </div>

      <nav className="flex flex-wrap gap-2" aria-label="Learn modes">
        {LEARN_MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={mode === item.id ? "btn btn-primary" : "btn btn-ghost"}
            aria-pressed={mode === item.id}
            onClick={() => setMode(item.id)}
          >
            {item.label}
            {item.status === "next" && <span className="mono ml-2 text-[10px] font-normal opacity-80">next</span>}
          </button>
        ))}
      </nav>

      {error && !fileMissing && <p className="text-sm text-danger">{error}</p>}

      {fileMissing ? (
        <div className="panel p-6">
          <StudyReupload
            token={token}
            defended={status === "defended" || error === STUDY_FILE_DELETED}
            message={error ?? STUDY_FILE_DELETED}
            onUploaded={() => {
              if (status !== "defended" && error !== STUDY_FILE_DELETED) setDocumentAvailable(true);
              setError(null);
              void load(false);
            }}
          />
        </div>
      ) : (
        <LearnModeBody
          mode={mode}
          token={token}
          busy={busy}
          companion={companion}
          current={current}
          cardsLoaded={cards !== null}
          remaining={remaining}
          done={done}
          revealed={revealed}
          allowRegenerate={documentAvailable !== false}
          documentAvailable={documentAvailable !== false}
          onReveal={() => setRevealed(true)}
          onRate={(rating) => void rate(rating)}
          onReload={(regenerate) => void load(regenerate)}
        />
      )}
    </div>
  );
}

function LearnModeBody(props: {
  mode: LearnModeId;
  token: string;
  busy: boolean;
  companion: CompanionState;
  current: StudyCard | undefined;
  cardsLoaded: boolean;
  remaining: number;
  done: number;
  revealed: boolean;
  allowRegenerate: boolean;
  documentAvailable: boolean;
  onReveal: () => void;
  onRate: (rating: RatingName) => void;
  onReload: (regenerate: boolean) => void;
}) {
  switch (props.mode) {
    case "flashcards":
      return (
        <FlashcardStudy
          busy={props.busy}
          companion={props.companion}
          current={props.current}
          cardsLoaded={props.cardsLoaded}
          remaining={props.remaining}
          done={props.done}
          revealed={props.revealed}
          allowRegenerate={props.allowRegenerate}
          onReveal={props.onReveal}
          onRate={props.onRate}
          onReload={props.onReload}
        />
      );
    case "quiz":
    case "explain_back":
    case "weak_spots":
      return <UpcomingMode mode={props.mode} token={props.token} documentAvailable={props.documentAvailable} />;
    default: {
      const unknown: never = props.mode;
      return unknown;
    }
  }
}

function FlashcardStudy(props: {
  busy: boolean;
  companion: CompanionState;
  current: StudyCard | undefined;
  cardsLoaded: boolean;
  remaining: number;
  done: number;
  revealed: boolean;
  allowRegenerate: boolean;
  onReveal: () => void;
  onRate: (rating: RatingName) => void;
  onReload: (regenerate: boolean) => void;
}) {
  if (!props.cardsLoaded || (props.busy && !props.current)) {
    return (
      <div className="panel grid justify-items-center gap-3 p-8 text-center">
        <Companion state="thinking" size={84} />
        <p className="text-lg font-semibold">Writing cards from your file…</p>
      </div>
    );
  }

  if (!props.current) {
    return (
      <div className="panel grid justify-items-center gap-3 p-8 text-center">
        <Companion state="impressed" size={84} />
        <p className="text-lg font-semibold">{props.done > 0 ? "That's the deck for now." : "No cards are due."}</p>
        <p className="max-w-md text-[var(--ink-2)]">
          {props.allowRegenerate
            ? "Cards come back when they are due. Regenerating builds a fresh deck from the same file and replaces this one."
            : "Cards come back when they are due. This deck was saved before the file text was deleted."}
        </p>
        {props.allowRegenerate && (
          <button type="button" className="btn btn-ghost" disabled={props.busy} onClick={() => props.onReload(true)}>
            {props.busy ? "Writing cards…" : "Regenerate cards"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-sm text-[var(--ink-2)]">
          {props.done} done · {props.remaining} left
        </span>
        {props.allowRegenerate && (
          <button type="button" className="btn btn-ghost" disabled={props.busy} onClick={() => props.onReload(true)}>
            {props.busy ? "Writing cards…" : "Regenerate"}
          </button>
        )}
      </div>
      <div className="panel grid gap-5 p-5 sm:p-6">
        <div className="grid grid-cols-[auto_1fr] items-start gap-4">
          <Companion state={props.companion} size={64} />
          <div className="min-w-0">
            <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Question</span>
            <p className="mt-1 text-lg font-semibold" aria-live="polite">
              {props.current.front}
            </p>
          </div>
        </div>

        {props.revealed ? (
          <>
            <div className="border-t-[1.5px] border-[var(--ink)] pt-4">
              <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">Answer</span>
              <p className="mt-1">{props.current.back}</p>
            </div>
            {props.current.source && (
              <div>
                <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">Source</span>
                <p className="mt-1 text-sm text-[var(--ink-2)]">{props.current.source}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="How well did you recall it?">
              {RATINGS.map((rating) => (
                <button
                  key={rating.key}
                  type="button"
                  className={rating.key === "good" ? "btn btn-primary" : "btn btn-ghost"}
                  onClick={() => props.onRate(rating.key)}
                  aria-keyshortcuts={rating.shortcut}
                >
                  <span className="grid text-center leading-tight">
                    <span>{rating.label}</span>
                    <span className="mono text-[10px] font-normal opacity-80">
                      {rating.hint} · {rating.shortcut}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <button type="button" className="btn btn-primary justify-self-start" onClick={props.onReveal}>
            Show answer <span className="mono ml-2 text-[10px] opacity-80">space</span>
          </button>
        )}
      </div>
    </div>
  );
}

function UpcomingMode({
  mode,
  token,
  documentAvailable,
}: {
  mode: Exclude<LearnModeId, "flashcards">;
  token: string;
  documentAvailable: boolean;
}) {
  const spec = learnMode(mode);
  return (
    <div className="panel grid gap-3 p-6">
      <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">
        {learnModeStatus(mode) === "next" ? "Next" : "Ready"}
      </span>
      <h2 className="text-2xl font-bold">{spec.label}</h2>
      <p>{spec.summary}</p>
      <UpcomingDetail mode={mode} token={token} documentAvailable={documentAvailable} />
    </div>
  );
}

function UpcomingDetail({
  mode,
  token,
  documentAvailable,
}: {
  mode: Exclude<LearnModeId, "flashcards">;
  token: string;
  documentAvailable: boolean;
}) {
  switch (mode) {
    case "quiz":
      return (
        <p className="text-sm text-[var(--ink-2)]">
          The quiz will reuse this deck: a short question, your answer, then the source line. It stays private and
          does not issue a receipt.
        </p>
      );
    case "explain_back":
      return (
        <div className="grid gap-3">
          <p className="text-sm text-[var(--ink-2)]">
            Explain-back asks you to teach one section before the file wording is shown. The private coach is the
            conversation that starts that practice.
          </p>
          {documentAvailable ? (
            <Link href={`/d/${token}/learn/coach`} className="btn btn-ghost justify-self-start">
              Talk it through with the coach
            </Link>
          ) : (
            <p className="text-sm text-[var(--ink-2)]">
              The coach needs the file text, and that text was deleted. Flashcards from the saved deck still work.
            </p>
          )}
        </div>
      );
    case "weak_spots":
      return (
        <p className="text-sm text-[var(--ink-2)]">
          After Defend, the private gap map lists each section as weak, partial, or strong. This mode will reopen the
          weak sections first, then the partial ones, and leave strong sections out of the drill.
        </p>
      );
    default: {
      const unknown: never = mode;
      return unknown;
    }
  }
}
