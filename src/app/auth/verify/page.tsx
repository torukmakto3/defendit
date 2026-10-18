"use client";

import { useEffect, useState } from "react";

/**
 * The token arrives in the URL fragment, which browsers never send to the
 * server or in Referer headers. Signing in needs a click, so email link
 * scanners that prefetch URLs can't burn the one-time token.
 */
export default function VerifyPage() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(t);
    // Drop the token from the address bar and history.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function signIn() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sign-in failed");
      window.location.href = data.next || "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="shell max-w-lg">
      <div className="panel rounded-2xl p-8 text-center">
        <h1 className="text-3xl text-[var(--moss)]">Sign in to Defend It</h1>
        {token ? (
          <button className="btn btn-primary mt-6" onClick={signIn} disabled={busy}>
            {busy ? "Signing in…" : "Continue"}
          </button>
        ) : (
          <p className="mt-4 opacity-75">This link is missing its token. Request a new one.</p>
        )}
        {error && <p className="mt-4 text-[var(--amber)]">{error}</p>}
      </div>
    </div>
  );
}
