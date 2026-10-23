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
  kind: "creator" | "receiver" | "demo";
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

  const defendAvailable = data.status !== "defended" && !d?.purged;

  return (
    <div className="shell grid max-w-2xl gap-8">
      <header className="grid gap-3">
        <p className="eyebrow">
          {data.kind === "demo" ? "Sample demo" : data.kind === "receiver" ? "Defense request" : "Your deliverable"}
        </p>
        <h1 className="type-page">{data.title}</h1>
        <p className="text-sm text-[var(--ink-2)]">
          Difficulty <strong>{data.difficulty}</strong> · status <strong>{data.status}</strong>
        </p>
        {data.notes && data.kind === "receiver" && (
          <p className="text-sm text-[var(--ink-2)]">Note from the requester: {data.notes}</p>
        )}
      </header>

      {data.kind === "demo" && (
        <div className="grid gap-4">
          <div className="panel grid gap-3 p-5">
            <p>
              This is a sample-file demo. No account is needed for the short interview. The receipt
              is marked as a demo and is not a credential.
            </p>
            {data.status !== "defended" && (
              <Link className="btn btn-primary w-full justify-self-start sm:w-auto" href={`/d/${token}/defend`}>
                Continue the sample defense
              </Link>
            )}
          </div>
          {!me && <SignInCard title="Sign in and defend your own file (3 free)" />}
        </div>
      )}

      {!me && data.kind !== "demo" && <SignInCard title="Sign in to defend this deliverable" />}

      {me && data.isOwner && !data.isCreator && (
        <div className="panel grid gap-3 p-5">
          <p>
            You requested this defense. Share this page&apos;s link with the creator. Results appear on
            your <Link className="text-[var(--blueprint)] underline" href="/dashboard">dashboard</Link>.
          </p>
          {d && (
            <p className="mono break-all text-xs">sha256:{d.sha256}</p>
          )}
        </div>
      )}

      {me && !mayUpload && !data.isOwner && data.kind !== "demo" && (
        <p className="panel p-5">This defense belongs to another account.</p>
      )}

      {me && mayUpload && !d && (
        <form onSubmit={onUpload} className="panel grid gap-4 p-5">
          <p className="text-sm">
            Upload the exact file you will defend (PDF, DOCX, XLSX, CSV, TXT or MD). We keep its SHA-256
            fingerprint, not the file. The extracted text is encrypted and deleted when you finish.
          </p>
          <input name="file" type="file" className="field" accept=".pdf,.docx,.txt,.md,.markdown,.xlsx,.xls,.csv" required />
          <button className="btn btn-primary w-full justify-self-start sm:w-auto" disabled={uploading}>
            {uploading ? "Parsing & extracting claims…" : "Upload"}
          </button>
        </form>
      )}

      {me && data.isCreator && d && (
        <div className="panel grid gap-4 p-5">
          <p>
            Uploaded <strong>{d.fileName ?? "file (name purged)"}</strong> · {d.claimCount} claims
          </p>
          <p className="mono break-all text-xs">sha256:{d.sha256}</p>
          {d.purged && <p className="text-sm text-[var(--amber)]">This upload has expired and was purged.</p>}
          <div className="grid gap-3">
            {defendAvailable && (
              <Link className="btn btn-primary w-full justify-self-start sm:w-auto" href={`/d/${token}/defend`} prefetch>
                Start Defend interview
              </Link>
            )}
            {d.documentAvailable || d.studyDeck ? (
              <Link className="btn btn-ghost w-full justify-self-start sm:w-auto" href={`/d/${token}/learn`} prefetch>
                {data.status === "defended" ? "Learn" : "Learn first (private)"}
              </Link>
            ) : (
              <StudyReupload
                token={token}
                defended={data.status === "defended"}
                message={data.status === "defended" ? STUDY_FILE_DELETED : STUDY_TEXT_EXPIRED}
                onUploaded={() => router.push(`/d/${token}/learn`)}
                emphasis={defendAvailable ? "secondary" : "primary"}
              />
            )}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
