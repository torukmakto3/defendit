"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SignInCard, useMe } from "@/components/auth";
import { StudyReupload } from "@/components/study-reupload";
import { STUDY_FILE_DELETED, STUDY_TEXT_EXPIRED } from "@/lib/study-file";

interface RequestView {
  title: string;
  difficulty: string;
  status: string;
  kind: "creator" | "receiver";
  notes: string | null;
  isCreator: boolean;
  isOwner: boolean;
  canClaim: boolean;
  deliverable: {
    fileName: string | null;
    sha256: string;
    byteLength: number;
    claimCount: number;
    documentAvailable: boolean;
    studyDeck: boolean;
    purged: boolean;
  } | null;
}

export default function CreatorEntryPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const { me } = useMe();
  const [data, setData] = useState<RequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/requests/${token}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Not found");
    return j as RequestView;
  }, [token]);

  useEffect(() => {
    if (me === undefined) return;
    let cancelled = false;
    load()
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Not found");
      });
    return () => {
      cancelled = true;
    };
  }, [load, me]);

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fileInput = e.currentTarget.elements.namedItem("file") as HTMLInputElement;
    if (!fileInput.files?.[0]) return;
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("token", token);
      body.set("file", fileInput.files[0]);
      const res = await fetch("/api/upload", { method: "POST", body });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Upload failed");
      setData(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  if (error && !data) {
    return (
      <div className="shell">
        <p className="text-danger">{error}</p>
      </div>
    );
  }
  if (!data || me === undefined) {
    return (
      <div className="shell">
        <p>Loading defense…</p>
      </div>
    );
  }

  const d = data.deliverable;
  const mayUpload = data.isCreator || data.canClaim;

  return (
    <div className="shell max-w-2xl">
      <p className="eyebrow">
        {data.kind === "receiver" ? "Defense request" : "Your deliverable"}
      </p>
      <h1 className="mt-2 text-3xl font-bold sm:text-4xl">{data.title}</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Difficulty <strong>{data.difficulty}</strong> · status <strong>{data.status}</strong>
      </p>
      {data.notes && data.kind === "receiver" && (
        <p className="mt-2 text-sm opacity-75">Note from the requester: {data.notes}</p>
      )}

      {!me && (
        <div className="mt-8">
          <SignInCard title="Sign in to defend this deliverable" />
        </div>
      )}

      {me && data.isOwner && !data.isCreator && (
        <div className="panel mt-8 p-6">
          <p>
            You requested this defense. Share this page&apos;s link with the creator. Results appear on
            your <Link className="text-[var(--moss)] underline" href="/dashboard">dashboard</Link>.
          </p>
          {d && (
            <p className="mt-3 font-mono text-xs break-all">sha256:{d.sha256}</p>
          )}
        </div>
      )}

      {me && !mayUpload && !data.isOwner && (
        <p className="panel mt-8 p-6">This defense belongs to another account.</p>
      )}

      {me && mayUpload && !d && (
        <form onSubmit={onUpload} className="panel mt-8 space-y-4 p-6">
          <p className="text-sm">
            Upload the exact file you will defend (PDF, DOCX, XLSX, CSV, TXT or MD). We keep its SHA-256
            fingerprint, not the file. The extracted text is encrypted and deleted when you finish.
          </p>
          <input name="file" type="file" className="field" accept=".pdf,.docx,.txt,.md,.markdown,.xlsx,.xls,.csv" required />
          <button className="btn btn-primary" disabled={uploading}>
            {uploading ? "Parsing & extracting claims…" : "Upload"}
          </button>
        </form>
      )}

      {me && data.isCreator && d && (
        <div className="panel mt-8 space-y-4 p-6">
          <p>
            Uploaded <strong>{d.fileName ?? "file (name purged)"}</strong> · {d.claimCount} claims
          </p>
          <p className="font-mono text-xs break-all">sha256:{d.sha256}</p>
          {d.purged && <p className="text-sm text-[var(--amber)]">This upload has expired and was purged.</p>}
          <div className="grid gap-3">
            {d.documentAvailable || d.studyDeck ? (
              <Link className="btn btn-ghost justify-self-start" href={`/d/${token}/learn`} prefetch>
                {data.status === "defended" ? "Learn" : "Learn first (private)"}
              </Link>
            ) : (
              <StudyReupload
                token={token}
                defended={data.status === "defended"}
                message={data.status === "defended" ? STUDY_FILE_DELETED : STUDY_TEXT_EXPIRED}
                onUploaded={() => router.push(`/d/${token}/learn`)}
              />
            )}
            {data.status !== "defended" && !d.purged && (
              <Link className="btn btn-primary justify-self-start" href={`/d/${token}/defend`} prefetch>
                Start Defend interview
              </Link>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
    </div>
  );
}
