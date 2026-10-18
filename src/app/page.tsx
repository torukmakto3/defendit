"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

const ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.xlsx,.xls,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,text/csv";

export default function HomePage() {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatorName, setCreatorName] = useState("Ana Analyst");
  const [creatorEmail, setCreatorEmail] = useState("ana@fund.example");
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
        body.set("creatorName", creatorName);
        body.set("creatorEmail", creatorEmail);
        body.set("difficulty", difficulty);
        const res = await fetch("/api/creator/ingest", {
          method: "POST",
          body,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        sessionStorage.setItem(
          `defend-it:${data.token}:creator`,
          JSON.stringify({ creatorName, creatorEmail }),
        );
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
    [creatorName, creatorEmail, difficulty],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void ingestFile(file);
  }

  return (
    <div className="shell">
      <section className="relative overflow-hidden rounded-2xl panel px-6 py-12 sm:px-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%231f4d2e' fill-opacity='0.06'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
          }}
        />
        <div className="relative">
          <p className="brand animate-rise text-5xl leading-none text-[var(--moss)] sm:text-6xl">
            Defend It
          </p>
          <div className="seal-line mt-5 h-px w-40 bg-[var(--moss)]" />
          <h1 className="animate-rise-delay mt-8 max-w-2xl text-3xl leading-tight text-[var(--ink)] sm:text-4xl">
            Drop the deliverable. Learn it. Defend it. Send a stamped copy.
          </h1>
          <p className="animate-rise-delay-2 mt-5 max-w-xl text-lg text-[color-mix(in_srgb,var(--ink)_72%,transparent)]">
            PDF, Excel, Word, or Markdown. Private Learn coach, short Defend
            interview, then a signed stamp + QR you attach and send however you
            already work.
          </p>

          <div className="animate-rise-delay-2 mt-8 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="creatorName">
                Your name
              </label>
              <input
                id="creatorName"
                className="field"
                value={creatorName}
                onChange={(e) => setCreatorName(e.target.value)}
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
                <option value="standard">Standard</option>
                <option value="hard">Hard</option>
                <option value="expert">Expert</option>
              </select>
            </div>
          </div>

          <div
            className={`mt-8 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition ${
              dragging
                ? "border-[var(--moss)] bg-[color-mix(in_srgb,var(--mist)_80%,white)]"
                : "border-[var(--line)] bg-[color-mix(in_srgb,var(--paper)_88%,white)]"
            }`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {busy ? (
              <p className="text-lg text-[var(--moss)]">
                Parsing & extracting claims…
              </p>
            ) : (
              <>
                <p className="text-xl text-[var(--ink)]">
                  Drag & drop your memo, model, or deck here
                </p>
                <p className="mt-2 text-sm text-[color-mix(in_srgb,var(--ink)_55%,transparent)]">
                  PDF · DOCX · XLSX · CSV · TXT · MD
                </p>
                <label className="btn btn-primary mt-6 cursor-pointer">
                  Choose file
                  <input
                    type="file"
                    className="hidden"
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

          {error && <p className="mt-4 text-sm text-red-700">{error}</p>}

          {ready && (
            <div className="mt-8 rounded-xl border border-[var(--line)] bg-white/70 p-6">
              <p className="text-sm uppercase tracking-[0.12em] text-[var(--leaf)]">
                Ready
              </p>
              <h2 className="mt-2 text-2xl text-[var(--moss)]">{ready.title}</h2>
              <p className="mt-2 text-sm">
                {ready.claimCount} claims extracted · sha256:
                <span className="ml-1 font-mono text-xs">
                  {ready.sha256.slice(0, 16)}…
                </span>
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => router.push(ready.learnUrl)}
                >
                  Learn (private)
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => router.push(ready.defendUrl)}
                >
                  Defend now
                </button>
              </div>
              <p className="mt-4 text-xs text-[color-mix(in_srgb,var(--ink)_55%,transparent)]">
                Learn never leaves this session. Defend issues the stamped
                receipt you can email or Slack to anyone.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="mt-12 grid gap-8 md:grid-cols-3">
        {[
          {
            title: "Learn",
            body: "Private explain-back, what-ifs, planted errors. Gap map stays with you.",
          },
          {
            title: "Defend",
            body: "Short live interview grounded in your file. Randomness drawn in code, not by the LLM.",
          },
          {
            title: "Stamp & send",
            body: "Signed score + QR on a badge. Attach it to the same PDF/model and send via your usual channel.",
          },
        ].map((item) => (
          <div key={item.title} className="panel rounded-xl p-6">
            <h2 className="text-2xl text-[var(--moss)]">{item.title}</h2>
            <p className="mt-3 text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
              {item.body}
            </p>
          </div>
        ))}
      </section>

      <p className="mt-10 text-center text-sm text-[color-mix(in_srgb,var(--ink)_55%,transparent)]">
        Receiver-initiated links still work for pilots that want them —{" "}
        <Link href="/request" className="text-[var(--moss)] underline">
          Request a defense
        </Link>
        {" · "}
        <Link href="/dashboard" className="text-[var(--moss)] underline">
          Dashboard
        </Link>
      </p>
    </div>
  );
}
