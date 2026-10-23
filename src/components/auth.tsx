"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

export interface Me {
  email: string;
  displayName: string | null;
}

type Session = { me: Me | null | undefined; isAdmin: boolean };

let session: Session = { me: undefined, isAdmin: false };
const listeners = new Set<() => void>();
let generation = 0;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

async function readSession(): Promise<Session> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  const data = await res.json();
  return { me: data.user ?? null, isAdmin: Boolean(data.isAdmin) };
}

function refreshSession() {
  const mine = ++generation;
  return (async () => {
    try {
      const next = await readSession();
      if (mine !== generation) return;
      session = next;
    } catch {
      if (mine !== generation) return;
      session = { me: null, isAdmin: false };
    }
    emit();
  })();
}

/** Current signed-in user; `undefined` while loading, `null` when signed out. */
export function useMe() {
  const current = useSyncExternalStore(subscribe, () => session, () => session);
  useEffect(() => {
    if (session.me !== undefined) return;
    void refreshSession();
  }, []);
  return { me: current.me, isAdmin: current.isAdmin, refresh: refreshSession };
}

export async function saveDisplayName(displayName: string) {
  await fetch("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: displayName.trim() || null }),
  });
}

type SignInMethods = { google: boolean; email: boolean };

let methods: SignInMethods | null | undefined;
const methodListeners = new Set<() => void>();
let methodsStarted = false;

function emitMethods() {
  for (const listener of methodListeners) listener();
}

function subscribeMethods(onStoreChange: () => void) {
  methodListeners.add(onStoreChange);
  return () => methodListeners.delete(onStoreChange);
}

function ensureMethods() {
  if (methodsStarted) return;
  methodsStarted = true;
  void (async () => {
    try {
      const res = await fetch("/api/auth/providers", { cache: "no-store" });
      const data = await res.json();
      methods = res.ok ? { google: Boolean(data.google), email: Boolean(data.email) } : null;
    } catch {
      methods = null;
    }
    emitMethods();
  })();
}

function useSignInMethods() {
  const current = useSyncExternalStore(subscribeMethods, () => methods, () => undefined);
  useEffect(() => {
    ensureMethods();
  }, []);
  return current;
}

function authErrorCode(): string | null {
  return new URLSearchParams(window.location.search).get("auth_error");
}

function subscribeLocation(onStoreChange: () => void) {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

const AUTH_ERROR_COPY: Record<string, string> = {
  state_mismatch: "Sign-in could not be confirmed. Start again.",
  expired: "That sign-in attempt expired. Start again.",
  unverified_email:
    "Google has not verified that email. Verify it on the Google account, then try again.",
  missing_email: "Google did not share an email address.",
  denied: "Google sign-in was cancelled.",
  invalid_token: "Google sign-in failed. Try again.",
  wrong_host: "Google sign-in is configured for a different site address.",
  not_configured: "Google sign-in is not turned on.",
  failed: "Google sign-in failed. Try again.",
};

function returnPath(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("auth_error");
  return `${url.pathname}${url.search}${url.hash}`;
}

function introFor(options: SignInMethods): string {
  if (options.google && options.email) {
    return "Sign in with Google, or use a one-time email link. No password. Your files stay private to your account.";
  }
  if (options.google) {
    return "Sign in with the Google account whose verified email you want on your receipt. No password.";
  }
  if (options.email) {
    return "We email you a one-time link. No password. Your files stay private to your account.";
  }
  return "";
}

function SignInShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel grid gap-4 p-5">
      <h2 className="type-section">{title}</h2>
      {children}
    </div>
  );
}

/** Resolved sign-in methods. `email` is the server boolean from `/api/auth/providers`. */
export function SignInChoices({
  options,
  title,
  next,
}: {
  options: SignInMethods;
  title: string;
  next?: string;
}) {
  const authError = useSyncExternalStore(subscribeLocation, authErrorCode, () => null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const googleHref = next ? `/api/auth/google?next=${encodeURIComponent(next)}` : "/api/auth/google";

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
          next: next ?? returnPath(),
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

  const shownError = error ?? (authError ? AUTH_ERROR_COPY[authError] ?? "Sign-in failed. Try again." : null);

  return (
    <SignInShell title={title}>
      {sent ? (
        <div className="grid gap-3">
          <p>Check <strong>{email}</strong> for your sign-in link. It expires in 15 minutes.</p>
          {devLink && (
            <a className="btn btn-primary w-full sm:w-auto" href={devLink}>
              Open sign-in link (dev mode)
            </a>
          )}
        </div>
      ) : (
        <>
          {introFor(options) && <p className="text-sm text-[var(--ink-2)]">{introFor(options)}</p>}
          {options.google && (
            <a className="btn btn-primary w-full" href={googleHref}>
              Sign in with Google
            </a>
          )}
          {options.google && options.email && (
            <div className="flex items-center gap-3 text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">
              <span className="h-px flex-1 bg-[var(--line)]" />
              or
              <span className="h-px flex-1 bg-[var(--line)]" />
            </div>
          )}
          {options.email ? (
            <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
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
              <button className={options.google ? "btn btn-ghost w-full sm:w-auto" : "btn btn-primary w-full sm:w-auto"} disabled={busy}>
                {busy ? "Sending…" : "Email me a link"}
              </button>
            </form>
          ) : (
            !options.google && (
              <p className="text-sm">
                Sign-in isn&apos;t available on this server yet. Google sign-in and email links are both turned off.
              </p>
            )
          )}
        </>
      )}
      {shownError && <p className="text-sm text-[var(--amber)]">{shownError}</p>}
    </SignInShell>
  );
}

/** Google first, then an email link when that path is actually available. */
export function SignInCard({ title = "Sign in to continue", next }: { title?: string; next?: string }) {
  const options = useSignInMethods();
  if (options === undefined) {
    return (
      <SignInShell title={title}>
        <p className="text-sm text-[var(--ink-2)]">Loading sign-in…</p>
      </SignInShell>
    );
  }
  if (options === null) {
    return (
      <SignInShell title={title}>
        <p className="text-sm text-[var(--amber)]">
          Could not load sign-in options. Refresh and try again.
        </p>
      </SignInShell>
    );
  }
  return <SignInChoices options={options} title={title} next={next} />;
}

export function AccountMenu() {
  const router = useRouter();
  const { me, isAdmin, refresh } = useMe();
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
          await refresh();
          router.push("/");
          router.refresh();
        }}
      >
        Sign out
      </button>
    </span>
  );
}
