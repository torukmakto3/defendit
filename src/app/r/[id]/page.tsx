"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Companion } from "@/components/companion/Companion";
import { LoadTest } from "@/components/receipt/LoadTest";
import { claimResults } from "@/components/receipt/metrics";
import { PlotterStamp } from "@/components/receipt/PlotterStamp";
import { ToleranceChart } from "@/components/receipt/ToleranceChart";
import type { SignedReceipt } from "@/lib/types";

interface ReceiptView {
  receipt: SignedReceipt;
  signatureValid: boolean;
}

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ReceiptView | null>(null);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/receipts/${id}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Not found");
        setData(j);
      })
      .catch((e) => setError(e.message));
    // Claim names only come back for the receipt's creator, within retention.
    fetch(`/api/receipts/${id}/labels`)
      .then((r) => (r.ok ? r.json() : { labels: null }))
      .then((j) => setLabels(j.labels ?? null))
      .catch(() => setLabels(null));
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
  const defended = p.outcome === "Defended";
  const { claims, approximate } = claimResults(p, labels);

  return (
    <div className="shell grid max-w-4xl gap-8">
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

      <PlotterStamp payload={p} verifyUrl={data.receipt.verifyUrl} />

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-2xl font-bold">How the claims held up</h2>
          <span className="text-xs text-[var(--ink-2)]">
            {labels
              ? "Claim names are visible only to you."
              : approximate
                ? "Approximate: this receipt predates per-claim scores."
                : "Claims are numbered; their content stays private."}
          </span>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="panel grid content-start gap-2 p-5">
            <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Load test</span>
            <p className="text-sm text-[var(--ink-2)]">Each claim is a support under the deliverable. Weak supports crack.</p>
            <LoadTest claims={claims} score={p.score} outcome={p.outcome} />
          </div>
          <div className="panel grid content-start gap-2 p-5">
            <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Tolerance chart</span>
            <p className="text-sm text-[var(--ink-2)]">Each claim&apos;s score against the spec: 50 passes, 75 is strong.</p>
            <ToleranceChart claims={claims} />
          </div>
        </div>
      </section>

      <section className="grid gap-3">
        <h2 className="text-2xl font-bold">Details</h2>
        <div className="titleblock" style={{ gridTemplateColumns: "1fr" }}>
          <div><small>SHA-256 of the defended file</small><b>{p.deliverable.sha256}</b></div>
          <div>
            <small>Defended by</small>
            <b>
              {p.creator
                ? `${p.creator.displayName} (self-reported name, verified email sign-in)`
                : "Not disclosed by the creator"}
            </b>
          </div>
          <div><small>Integrity (reported separately from the score)</small><b>{p.integrity.status}</b></div>
          <div><small>Receipt</small><b>{p.id} &middot; rubric {p.rubricVersion}</b></div>
        </div>
        <p className="text-xs text-[var(--ink-2)]">
          This receipt holds no document content, answers, file name or email. The deliverable stays
          with the people it was sent to; drop it on the verify page to check it matches.
        </p>
      </section>

      <div className="panel p-5">
        <h2 className="text-xl font-bold">Send it your way</h2>
        <p className="mt-2 text-sm text-[var(--ink-2)]">
          Attach the receipt PDF to the file you defended, or paste the stamp image into your email,
          Slack or Docs. The receiver scans the code or opens the link and drops their copy of the
          file to check it. No account needed.
        </p>
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
      <p className="text-xs text-[var(--ink-2)]">
        Graded with {p.modelVersions.join(", ")} &middot; {p.rubricVersion}
      </p>
    </div>
  );
}
