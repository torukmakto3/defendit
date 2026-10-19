"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Companion } from "@/components/companion/Companion";
import type { SignedReceipt } from "@/lib/types";

interface ReceiptView {
  receipt: SignedReceipt;
  signatureValid: boolean;
}

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ReceiptView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/receipts/${id}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Not found");
        setData(j);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="shell">
        <p className="text-danger">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="shell">
        <p>Loading receipt…</p>
      </div>
    );
  }

  const p = data.receipt.payload;
  const diff = p.difficulty.charAt(0).toUpperCase() + p.difficulty.slice(1);

  const defended = p.outcome === "Defended";

  return (
    <div className="shell max-w-3xl">
      <div className="grid grid-cols-[auto_1fr] items-center gap-4 sm:gap-5">
        <Companion state={defended ? "surprised" : p.outcome === "Not defended" ? "skeptical" : "listening"} size={72} />
        <div className="min-w-0">
          <p className="eyebrow">Understanding receipt</p>
          <h1 className="mt-1 text-3xl font-bold sm:text-4xl">{p.outcome}</h1>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            <span className={data.signatureValid ? "text-[var(--ok)]" : "text-danger"}>
              {data.signatureValid ? "Signature valid" : "Signature invalid"}
            </span>{" "}
            &middot; {new Date(p.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      <div className="relative mt-10">
        {defended && <span className="approved absolute -top-6 right-3 bg-[var(--card)] text-lg">APPROVED</span>}
        <div className="titleblock">
          <div><small>Outcome</small><b>{p.outcome}</b></div>
          <div><small>Score</small><b>{p.score}/100</b></div>
          <div><small>Level</small><b>{diff}</b></div>
          <div><small>Date</small><b>{p.createdAt.slice(0, 10)}</b></div>
          <div><small>Strong / partial / weak</small><b>{p.bands.strong} / {p.bands.partial} / {p.bands.weak}</b></div>
          <div><small>Integrity (separate)</small><b>{p.integrity.status}</b></div>
        </div>
        <div className="titleblock titleblock-rows">
          <div><small>SHA-256 of the defended file</small><b>{p.deliverable.sha256}</b></div>
          <div>
            <small>Defended by</small>
            <b>
              {p.creator
                ? `${p.creator.displayName} (self-reported name, verified email sign-in)`
                : "Not disclosed by the creator"}
            </b>
          </div>
          <div><small>Receipt</small><b>{p.id} &middot; rubric {p.rubricVersion}</b></div>
        </div>
      </div>

      <p className="mt-4 text-xs text-[var(--ink-2)]">
        This receipt holds no document content, answers, file name or email. The deliverable stays
        with the people it was sent to; drop it on the verify page to check it matches.
      </p>

      <div className="panel mt-8 p-5">
        <h2 className="text-xl font-bold">Send it your way</h2>
        <p className="mt-2 text-sm text-[var(--ink-2)]">
          Attach the receipt PDF to the file you defended, or paste the stamp image into your email,
          Slack or Docs. The receiver scans the code or opens the link and drops their copy of the
          file to check it. No account needed.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/stamp/${p.id}`}
          alt={`Defend It stamp: ${p.outcome}, ${p.score} of 100, ${diff}`}
          className="mt-4 h-auto w-full max-w-[460px]"
        />
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <a href={`/api/receipts/${p.id}/pdf`} className="btn btn-primary">
            Download receipt (PDF)
          </a>
          <a href={`/api/stamp/${p.id}?format=png&download=1`} className="btn btn-ghost">
            Download stamp image (PNG)
          </a>
          <Link href={`/verify/${p.id}`} className="btn btn-ghost">
            Verify file hash
          </Link>
        </div>
      </div>
      <p className="mt-4 text-xs text-[var(--ink-2)]">
        Graded with {p.modelVersions.join(", ")} · {p.rubricVersion}
      </p>
    </div>
  );
}
