"use client";

import { useState } from "react";

export function PortalButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = (await res.json()) as { url?: string; error?: string };
      if (res.status === 401) {
        setError("Sign in to manage billing.");
        return;
      }
      if (!res.ok || typeof body.url !== "string") {
        throw new Error(body.error || "Could not open the billing portal");
      }
      window.location.assign(body.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the billing portal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-primary mt-3" disabled={busy} onClick={() => void open()}>
        {busy ? "Opening the portal…" : label}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
