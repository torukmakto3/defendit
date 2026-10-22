"use client";

import { useState } from "react";

const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.xlsx,.xls,.csv";

/**
 * Re-upload used when Learn has no cached deck and the extracted text is gone.
 * A finished defense must be the same bytes (the receipt stays bound to that hash).
 * Before a defense, the normal upload replaces the deliverable.
 */
export function StudyReupload({
  token,
  defended,
  message,
  onUploaded,
  emphasis = "primary",
}: {
  token: string;
  defended: boolean;
  message: string;
  onUploaded?: () => void;
  /** Secondary when the page already has its own primary action. */
  emphasis?: "primary" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fileInput = e.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("token", token);
      body.set("file", file);
      const res = await fetch(defended ? "/api/learn/restore" : "/api/upload", { method: "POST", body });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Upload failed");
      onUploaded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <p>{message}</p>
      <input name="file" type="file" className="field" accept={ACCEPT} required />
      <button
        className={`btn w-full justify-self-start sm:w-auto ${emphasis === "primary" ? "btn-primary" : "btn-ghost"}`}
        disabled={busy}
      >
        {busy ? "Reading the file…" : "Upload the file"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}
