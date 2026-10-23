"use client";

import { useEffect, useState } from "react";

const RATINGS = [1, 2, 3, 4, 5] as const;

export function DefenseFeedback({ receiptId }: { receiptId: string }) {
  const [canSubmit, setCanSubmit] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/receipts/${receiptId}/feedback`)
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as { canSubmit?: boolean; rating?: number | null; comment?: string | null };
      })
      .then((body) => {
        if (cancelled || !body?.canSubmit) return;
        setCanSubmit(true);
        if (typeof body.rating === "number") setRating(body.rating);
        setComment(body.comment ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [receiptId]);

  if (!canSubmit) return null;

  async function submit() {
    if (rating == null) {
      setError("Choose a rating from 1 to 5.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/receipts/${receiptId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating, comment }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || "Could not save feedback");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save feedback");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="panel grid gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="type-section">How was the defense?</h2>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Rating from 1 to 5">
        {RATINGS.map((value) => (
          <button
            key={value}
            type="button"
            className="btn btn-ghost"
            aria-pressed={rating === value}
            onClick={() => {
              setRating(value);
              setSaved(false);
            }}
          >
            {value}
          </button>
        ))}
      </div>
      <label className="grid gap-2">
        <span className="label">Comment, optional</span>
        <textarea
          className="field min-h-24"
          maxLength={1000}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <button type="submit" className="btn btn-primary w-full justify-self-start sm:w-auto" disabled={busy}>
        {busy ? "Saving…" : saved ? "Saved" : "Save feedback"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}
