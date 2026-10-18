"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { saveDisplayName, SignInCard, useMe } from "@/components/auth";
import { Companion, type CompanionState } from "@/components/companion/Companion";

const ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.xlsx,.xls,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,text/csv";

export default function HomePage() {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { me } = useMe();
  const [displayName, setDisplayName] = useState("");
  useEffect(() => {
    if (me?.displayName) setDisplayName(me.displayName);
  }, [me]);
  const [difficulty, setDifficulty] = useState("hard");
  const [ready, setReady] = useState<{
    token: string;
    title: string;
    claimCount: number;
    sha256: string;
    learnUrl: string;
    defendUrl: string;
  } | null>(null);

  const ingestFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setReady(null);
      try {
        const body = new FormData();
        body.set("file", file);
        body.set("difficulty", difficulty);
        const res = await fetch("/api/creator/ingest", {
          method: "POST",
          body,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        setReady({
          token: data.token,
          title: data.title,
          claimCount: data.claimCount,
          sha256: data.sha256,
          learnUrl: data.learnUrl,
          defendUrl: data.defendUrl,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setBusy(false);
      }
    },
    [difficulty],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void ingestFile(file);
  }

  const companionState: CompanionState = busy
    ? "thinking"
    : dragging || ready
      ? "surprised"
      : error
        ? "skeptical"
        : "listening";

  return (
    <div className="shell grid gap-10">
      <section className="grid gap-4">
        <span className="eyebrow">Sheet 01 &middot; Drop</span>
        <h1 className="max-w-3xl text-3xl font-bold leading-tight sm:text-[44px]">
          Prove you understand what AI helped you make.
        </h1>
        <p className="max-w-2xl text-[var(--ink-2)]">
          Drop the memo, model or deck. Practise privately with the coach, take a short defense
          grounded in your file, and send it with a signed receipt anyone can verify.
        </p>
      </section>

      {me === null && <SignInCard title="Sign in to drop a deliverable" />}

      {me && (
        <section className="panel grid gap-6 p-5 sm:p-8">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="displayName">
                Name on receipts (optional)
              </label>
              <input
                id="displayName"
                className="field"
                placeholder="Shown only if you choose to"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() => void saveDisplayName(displayName)}
              />
            </div>
            <div>
              <label className="label" htmlFor="difficulty">
                Difficulty
              </label>
              <select
                id="difficulty"
                className="field"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
              >
                <option value="standard">Standard: key claims and why they hold</option>
                <option value="hard">Hard: what-ifs and a planted error</option>
                <option value="expert">Expert: adversarial cross-examination</option>
              </select>
            </div>
          </div>

          <div
            className={`grid items-center gap-5 border-2 border-dashed px-5 py-10 transition sm:grid-cols-[auto_1fr] sm:px-8 ${
              dragging
                ? "border-[var(--blueprint)] bg-[var(--mist)]"
                : "border-[var(--ink-2)] bg-[var(--card)]"
            }`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Companion state={companionState} size={92} className="justify-self-center" />
            <div className="grid justify-items-center gap-2 text-center sm:justify-items-start sm:text-left">
              {busy ? (
                <p className="text-lg font-semibold text-[var(--blueprint)]">
                  Reading the file and extracting its claims&hellip;
                </p>
              ) : (
                <>
                  <p className="text-lg font-semibold">Drag your deliverable here</p>
                  <p className="mono text-xs uppercase tracking-[0.08em] text-[var(--ink-2)]">
                    PDF &middot; DOCX &middot; XLSX &middot; CSV &middot; TXT &middot; MD &middot; up to 4 MB
                  </p>
                  <label className="btn btn-primary mt-2 cursor-pointer">
                    Choose file
                    <input
                      type="file"
                      className="sr-only"
                      accept={ACCEPT}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void ingestFile(file);
                      }}
                    />
                  </label>
                </>
              )}
            </div>
          </div>

          <p className="text-xs text-[var(--ink-2)]">
            Your file is read in memory and never stored. We keep its SHA-256 fingerprint; the
            extracted text is encrypted and deleted as soon as you finish defending (or after 72
            hours). Models run with zero data retention.
          </p>

          {error && <p className="text-sm text-danger">{error}</p>}

          {ready && (
            <div className="grid gap-4 border-t-[1.5px] border-[var(--ink)] pt-5">
              <div className="grid gap-1">
                <span className="eyebrow">Ready</span>
                <h2 className="text-2xl font-bold">{ready.title}</h2>
              </div>
              <div className="titleblock">
                <div><small>Claims found</small><b>{ready.claimCount}</b></div>
                <div><small>Difficulty</small><b>{difficulty}</b></div>
                <div><small>SHA-256</small><b>{ready.sha256.slice(0, 16)}&hellip;</b></div>
              </div>
              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn btn-ghost" onClick={() => router.push(ready.learnUrl)}>
                  Learn (private)
                </button>
                <button type="button" className="btn btn-primary" onClick={() => router.push(ready.defendUrl)}>
                  Defend now
                </button>
              </div>
              <p className="text-xs text-[var(--ink-2)]">
                Learn stays private to you. Defend issues the signed receipt you can send to anyone.
              </p>
            </div>
          )}
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-3">
        {[
          { step: "01", title: "Learn", body: "A private coach asks you to explain it back, poses what-ifs and plants errors. Your gap map stays with you." },
          { step: "02", title: "Defend", body: "A short interview grounded in your file. The questions are drawn in code, not chosen by the model." },
          { step: "03", title: "Send", body: "A signed score and QR bound to the file's hash. Attach the stamp and send it the way you already do." },
        ].map((item) => (
          <div key={item.title} className="panel grid content-start gap-2 p-5">
            <span className="mono text-xs text-[var(--blueprint)]">STEP {item.step}</span>
            <h2 className="text-xl font-bold">{item.title}</h2>
            <p className="text-[var(--ink-2)]">{item.body}</p>
          </div>
        ))}
      </section>

      <p className="text-center text-sm text-[var(--ink-2)]">
        Need someone else to defend a file?{" "}
        <Link href="/request" className="text-[var(--blueprint)] underline">
          Request a defense
        </Link>
        {" or open your "}
        <Link href="/dashboard" className="text-[var(--blueprint)] underline">
          dashboard
        </Link>
        .
      </p>
    </div>
  );
}
