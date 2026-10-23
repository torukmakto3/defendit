"use client";

import { useState } from "react";

export function FoundingWaitlistForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/founding/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || "Could not join the waitlist");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join the waitlist");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p>You are on the list. We will write when founding spots open.</p>;
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="grid gap-2">
        <span className="label">Email</span>
        <input
          className="field"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary w-full justify-self-start sm:w-auto" disabled={busy}>
        {busy ? "Joining…" : "Join the waitlist"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}
