"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

export interface Me {
  email: string;
  displayName: string | null;
}

/** Current signed-in user; `undefined` while loading, `null` when signed out. */
export function useMe() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json();
      setMe(data.user ?? null);
      setIsAdmin(Boolean(data.isAdmin));
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { me, isAdmin, refresh };
}

export async function saveDisplayName(displayName: string) {
  await fetch("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: displayName.trim() || null }),
  });
}

/** Email sign-in card. In dev (no email provider) it shows the link directly. */
export function SignInCard({ title = "Sign in to continue", next }: { title?: string; next?: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          next: next ?? window.location.pathname + window.location.search,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send link");
      setSent(true);
      setDevLink(data.devLink ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel rounded-2xl p-6">
      <h2 className="text-2xl text-[var(--moss)]">{title}</h2>
      <p className="mt-2 text-sm opacity-75">
        We email you a one-time link. No password. Your files stay private to your account.
      </p>
      {sent ? (
        <div className="mt-4 space-y-3">
          <p>Check <strong>{email}</strong> for your sign-in link. It expires in 15 minutes.</p>
          {devLink && (
            <a className="btn btn-primary" href={devLink}>
              Open sign-in link (dev mode)
            </a>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            type="email"
            required
            autoComplete="email"
            className="field flex-1"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Sending…" : "Email me a link"}
          </button>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-[var(--amber)]">{error}</p>}
    </div>
  );
}

export function AccountMenu() {
  const { me, isAdmin } = useMe();
  if (me === undefined) return null;
  if (!me) return null;
  return (
    <span className="flex items-center gap-3">
      {isAdmin && (
        <Link href="/admin" className="hover:text-[var(--moss)]">
          Admin
        </Link>
      )}
      <span className="hidden opacity-70 sm:inline">{me.email}</span>
      <button
        className="hover:text-[var(--moss)]"
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          window.location.href = "/";
        }}
      >
        Sign out
      </button>
    </span>
  );
}
