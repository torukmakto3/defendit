"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface RequestPayload {
  request: {
    title: string;
    difficulty: string;
    receiver_name: string;
    status: string;
  };
  deliverable: {
    id: string;
    fileName: string;
    sha256: string;
    claimCount: number;
  } | null;
}

export default function CreatorEntryPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [data, setData] = useState<RequestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatorName, setCreatorName] = useState("Ana Analyst");
  const [creatorEmail, setCreatorEmail] = useState("ana@fund.example");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    fetch(`/api/requests/${token}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Not found");
        setData(j);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const fileInput = formEl.elements.namedItem("file") as HTMLInputElement;
    if (!fileInput.files?.[0]) return;
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("token", token);
      body.set("creatorName", creatorName);
      body.set("creatorEmail", creatorEmail);
      body.set("file", fileInput.files[0]);
      const res = await fetch("/api/upload", { method: "POST", body });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Upload failed");
      sessionStorage.setItem(
        `defend-it:${token}:creator`,
        JSON.stringify({ creatorName, creatorEmail }),
      );
      const refreshed = await fetch(`/api/requests/${token}`).then((r) => r.json());
      setData(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  if (error && !data) {
    return (
      <div className="shell">
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="shell">
        <p>Loading defense request…</p>
      </div>
    );
  }

  return (
    <div className="shell max-w-2xl">
      <p className="text-sm uppercase tracking-[0.12em] text-[var(--leaf)]">
        Defense request
      </p>
      <h1 className="mt-2 text-4xl text-[var(--moss)]">{data.request.title}</h1>
      <p className="mt-3 text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
        From {data.request.receiver_name} · difficulty{" "}
        <strong>{data.request.difficulty}</strong>
      </p>

      {!data.deliverable ? (
        <form onSubmit={onUpload} className="panel mt-8 space-y-4 rounded-xl p-6">
          <p className="text-sm">
            Upload the exact file you will defend (PDF, DOCX, TXT, or MD). We hash
            the bytes for the receipt.
          </p>
          <div>
            <label className="label" htmlFor="creatorName">
              Your name
            </label>
            <input
              id="creatorName"
              className="field"
              value={creatorName}
              onChange={(e) => setCreatorName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="creatorEmail">
              Your email
            </label>
            <input
              id="creatorEmail"
              type="email"
              className="field"
              value={creatorEmail}
              onChange={(e) => setCreatorEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="file">
              Deliverable
            </label>
            <input id="file" name="file" type="file" accept=".pdf,.docx,.txt,.md,.markdown" required />
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={uploading}>
            {uploading ? "Parsing & extracting claims…" : "Upload and continue"}
          </button>
        </form>
      ) : (
        <div className="panel mt-8 space-y-4 rounded-xl p-6">
          <p>
            Uploaded <strong>{data.deliverable.fileName}</strong>
          </p>
          <p className="font-mono text-xs break-all text-[color-mix(in_srgb,var(--ink)_60%,transparent)]">
            sha256:{data.deliverable.sha256}
          </p>
          <p className="text-sm">{data.deliverable.claimCount} claims extracted.</p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              href={`/d/${token}/learn`}
              className="btn btn-ghost"
              onClick={() =>
                sessionStorage.setItem(
                  `defend-it:${token}:creator`,
                  JSON.stringify({ creatorName, creatorEmail }),
                )
              }
            >
              Learn first (private)
            </Link>
            <Link
              href={`/d/${token}/defend`}
              className="btn btn-primary"
              onClick={() =>
                sessionStorage.setItem(
                  `defend-it:${token}:creator`,
                  JSON.stringify({ creatorName, creatorEmail }),
                )
              }
            >
              Start Defend interview
            </Link>
          </div>
          <p className="text-xs text-[color-mix(in_srgb,var(--ink)_55%,transparent)]">
            LEARN is never shared. Only DEFEND produces a receipt.
          </p>
        </div>
      )}
    </div>
  );
}
