"use client";

import { useState } from "react";

export function CheckoutButton({ sku, label }: { sku: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (res.status === 401) {
        setError("Sign in to buy.");
        return;
      }
      if (!res.ok || typeof body.url !== "string") {
        throw new Error(body.error || "Could not start checkout");
      }
      window.location.assign(body.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-primary mt-3" disabled={busy} onClick={() => void buy()}>
        {busy ? "Starting checkout…" : label}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
