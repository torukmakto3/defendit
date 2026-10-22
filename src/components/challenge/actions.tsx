"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SHARE_DRAFTS = [
  {
    label: "Launches",
    text: "Bold launch. Want to defend it? 8 min, your own README, a receipt either way. Totally optional",
  },
  {
    label: "Claims",
    text: "Strong claim, and I think you might be right. Want to defend it against a file-grounded grill? Receipt either way",
  },
  {
    label: "Built with AI",
    text: "Built with AI, understood by you? Show it. 8-min defense of your own doc, receipt either way",
  },
];

/** Suggested reply the challenger posts from their own account. Editable. The product never posts it. */
export function SuggestedShares({ url }: { url: string }) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState(SHARE_DRAFTS[0].text);
  const [copied, setCopied] = useState(false);

  function pick(next: number) {
    setIndex(next);
    setText(SHARE_DRAFTS[next].text);
    setCopied(false);
  }

  return (
    <div className="panel grid gap-3 p-5">
      <p className="text-sm font-semibold">Suggested reply</p>
      <p className="text-sm text-[var(--ink-2)]">
        Edit it, then post it from your own account. It stays optional for them, and they control what is public.
      </p>
      <div className="flex flex-wrap gap-2">
        {SHARE_DRAFTS.map((draft, i) => (
          <button
            key={draft.label}
            type="button"
            className={i === index ? "btn btn-primary" : "btn btn-ghost"}
            onClick={() => pick(i)}
          >
            {draft.label}
          </button>
        ))}
      </div>
      <textarea className="field min-h-24" value={text} onChange={(e) => setText(e.target.value)} />
      <button
        type="button"
        className="btn btn-ghost justify-self-start"
        onClick={() => {
          void navigator.clipboard.writeText(`${text}\n${url}`);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy reply"}
      </button>
    </div>
  );
}

export function ShareBar({ slug, url, text }: { slug: string; url: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

  function track(channel: "x" | "copy") {
    void fetch(`/api/challenges/${slug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "share_clicked", channel }),
    });
  }

  return (
    <div className="flex flex-wrap gap-3">
      <a
        className="btn btn-ghost"
        href={intent}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => track("x")}
      >
        Share on X
      </a>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
          track("copy");
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

export function ClaimPanel({ slug }: { slug: string }) {
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${slug}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adultConfirmed: adult }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not accept");
      window.location.href = data.defensePath;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={adult}
          onChange={(e) => setAdult(e.target.checked)}
        />
        <span>I confirm I am 18 or older. Challenges are for adults.</span>
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="button" className="btn btn-primary justify-self-start" disabled={!adult || busy} onClick={() => void accept()}>
        {busy ? "Accepting…" : "Accept challenge"}
      </button>
    </div>
  );
}

export function DeclineButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${slug}/decline`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not close this challenge");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close this challenge");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="button" className="btn btn-ghost justify-self-start" disabled={busy} onClick={() => void decline()}>
        {busy ? "Closing…" : "No thanks"}
      </button>
      <p className="text-sm text-[var(--ink-2)]">Nothing is posted.</p>
    </div>
  );
}

export function RevokeButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${slug}/revoke`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not revoke");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="button" className="btn btn-ghost justify-self-start" disabled={busy} onClick={() => void revoke()}>
        {busy ? "Revoking…" : "Revoke link"}
      </button>
    </div>
  );
}

export function PublishChoice({
  slug,
  score,
  tier,
  already,
}: {
  slug: string;
  score: number;
  tier: string;
  already: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(visibility: "public" | "score_hidden" | "private") {
    setBusy(visibility);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${slug}/visibility`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");
      if (data.resultPath) router.push(data.resultPath);
      else router.push(`/c/${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(null);
    }
  }

  if (already) {
    return <p className="text-sm text-[var(--ink-2)]">You already chose how this result is shared.</p>;
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-[var(--ink-2)]">
        Your score is {score}/100, tier {tier}. Show the score, show the tier only, or keep it private. Nothing
        is posted unless you share it, and the choice does not change your credit.
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="button" className="btn btn-primary justify-self-start" disabled={!!busy} onClick={() => void choose("public")}>
        {busy === "public" ? "Saving…" : "Show the score"}
      </button>
      <button type="button" className="btn btn-ghost justify-self-start" disabled={!!busy} onClick={() => void choose("score_hidden")}>
        {busy === "score_hidden" ? "Saving…" : "Show the tier, hide the score"}
      </button>
      <button type="button" className="btn btn-ghost justify-self-start" disabled={!!busy} onClick={() => void choose("private")}>
        {busy === "private" ? "Saving…" : "Keep it private"}
      </button>
    </div>
  );
}

export function CreateChallengeForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: form.get("subject"),
          sourceUrl: form.get("sourceUrl") || undefined,
          targetHint: form.get("targetHint") || undefined,
          note: form.get("note") || undefined,
          difficulty: form.get("difficulty"),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create");
      setLink(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create");
    } finally {
      setBusy(false);
    }
  }

  if (link) {
    return (
      <div className="panel mt-8 p-6">
        <p className="eyebrow">Link ready</p>
        <p className="mt-3 break-all font-mono text-sm">{link}</p>
        <p className="mt-3 text-sm text-[var(--ink-2)]">
          Post it from your own account. They opt in or ignore it. You are not posting for them.
        </p>
        <button type="button" className="btn btn-primary mt-6" onClick={() => void navigator.clipboard.writeText(link)}>
          Copy link
        </button>
        <div className="mt-4">
          <SuggestedShares url={link} />
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="panel mt-8 grid gap-4 p-6">
      <div>
        <label className="label" htmlFor="subject">
          What should they defend?
        </label>
        <textarea id="subject" name="subject" required className="field min-h-28" maxLength={500} />
      </div>
      <div>
        <label className="label" htmlFor="sourceUrl">
          Source link (optional)
        </label>
        <input id="sourceUrl" name="sourceUrl" className="field" placeholder="https://" />
      </div>
      <div>
        <label className="label" htmlFor="targetHint">
          Who it&apos;s for (optional)
        </label>
        <input id="targetHint" name="targetHint" className="field" placeholder="@handle or email" maxLength={80} />
      </div>
      <div>
        <label className="label" htmlFor="note">
          Note (optional)
        </label>
        <textarea id="note" name="note" className="field min-h-20" maxLength={500} />
      </div>
      <div>
        <label className="label" htmlFor="difficulty">
          Difficulty
        </label>
        <select id="difficulty" name="difficulty" className="field" defaultValue="standard">
          <option value="standard">Standard</option>
          <option value="hard">Hard</option>
          <option value="expert">Expert</option>
        </select>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="submit" className="btn btn-primary justify-self-start" disabled={busy}>
        {busy ? "Creating…" : "Create challenge link"}
      </button>
    </form>
  );
}

export function OptOutForm({ initialOptedOut, initialHandles }: { initialOptedOut: boolean; initialHandles: string[] }) {
  const [optedOut, setOptedOut] = useState(initialOptedOut);
  const [handles, setHandles] = useState(initialHandles.join("\n"));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/challenges/opt-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optedOut,
          handles: handles
            .split(/[\s,]+/)
            .map((h) => h.trim())
            .filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="panel mt-8 grid gap-4 p-6">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={optedOut} onChange={(e) => setOptedOut(e.target.checked)} />
        <span>Don&apos;t challenge me again.</span>
      </label>
      <p className="text-sm text-[var(--ink-2)]">
        While this is on, you&apos;re on the do-not-challenge list. Challenges aimed at your email or the
        handles you list are blocked, and you can&apos;t accept one.
      </p>
      <div>
        <label className="label" htmlFor="handles">
          Handles
        </label>
        <textarea
          id="handles"
          className="field min-h-24"
          value={handles}
          onChange={(e) => setHandles(e.target.value)}
          placeholder={"yourname\nanother.handle"}
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-[var(--ok)]">Saved. You&apos;re on the do-not-challenge list.</p>}
      <button type="submit" className="btn btn-primary justify-self-start" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export function ReportForm({ slug }: { slug: string }) {
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${slug}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <p className="mt-6">Thanks. We received the report.</p>;

  return (
    <form onSubmit={submit} className="panel mt-8 grid gap-4 p-6">
      <label className="label" htmlFor="note">
        What should we know? (optional)
      </label>
      <textarea id="note" className="field min-h-24" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="submit" className="btn btn-primary justify-self-start" disabled={busy}>
        {busy ? "Sending…" : "Send report"}
      </button>
    </form>
  );
}
