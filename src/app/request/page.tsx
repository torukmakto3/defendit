"use client";

import { useState } from "react";
import Link from "next/link";
import { SignInCard, useMe } from "@/components/auth";

export default function RequestPage() {
  const { me } = useMe();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    shareUrl: string;
    token: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          difficulty: form.get("difficulty"),
          title: form.get("title"),
          notes: form.get("notes") || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult({ shareUrl: data.shareUrl, token: data.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="shell max-w-2xl">
      <h1 className="text-3xl font-bold sm:text-4xl">Request a defense</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Pick a difficulty, get a link, send it to the creator. They upload and
        defend — nothing to install.
      </p>

      {me === null ? (
        <div className="mt-8">
          <SignInCard title="Sign in to request a defense" />
        </div>
      ) : result ? (
        <div className="panel mt-8 p-6">
          <p className="eyebrow">
            Link ready
          </p>
          <p className="mt-3 break-all font-mono text-sm">{result.shareUrl}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigator.clipboard.writeText(result.shareUrl)}
            >
              Copy link
            </button>
            <Link href="/dashboard" className="btn btn-ghost">
              Go to dashboard
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="panel mt-8 space-y-4 p-6">
          <div>
            <label className="label" htmlFor="title">
              Deliverable title
            </label>
            <input
              id="title"
              name="title"
              className="field"
              required
              placeholder="Q4 IC memo — Project North"
            />
          </div>
          <div>
            <label className="label" htmlFor="difficulty">
              Difficulty
            </label>
            <select id="difficulty" name="difficulty" className="field" defaultValue="hard">
              <option value="standard">Standard — key claims and why they hold</option>
              <option value="hard">Hard — what-ifs, stretched assumptions, planted error</option>
              <option value="expert">Expert — adversarial cross-examination</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="notes">
              Notes (optional)
            </label>
            <textarea id="notes" name="notes" className="field min-h-24" />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? "Creating…" : "Create defense link"}
          </button>
        </form>
      )}
    </div>
  );
}
