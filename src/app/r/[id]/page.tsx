"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
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
        <p className="text-red-700">{error}</p>
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

  return (
    <div className="shell max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.12em] text-[var(--leaf)]">
            Understanding receipt
          </p>
          <h1 className="mt-2 text-4xl text-[var(--moss)]">
            {p.score}/100 · {diff}
          </h1>
          <p className="mt-2 text-sm">
            {data.signatureValid ? "✓ Signature valid" : "✗ Signature invalid"} ·{" "}
            {new Date(p.createdAt).toLocaleString()}
          </p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/stamp/${p.id}`}
          alt="Defend It stamp"
          className="h-[90px] w-auto rounded-md border border-[var(--line)] bg-white"
        />
      </div>

      <div className="panel mt-8 space-y-4 rounded-xl p-6">
        <div>
          <div className="label">Outcome</div>
          <div className="text-xl">{p.outcome}</div>
        </div>
        <div>
          <div className="label">Deliverable fingerprint</div>
          <div className="mt-1 break-all font-mono text-xs">
            sha256:{p.deliverable.sha256}
          </div>
          <div className="text-xs opacity-70">{p.deliverable.byteLength.toLocaleString()} bytes</div>
        </div>
        <div>
          <div className="label">Defended by</div>
          <div>
            {p.creator ? `${p.creator.displayName} · verified email` : "Not disclosed by the creator"}
          </div>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <div className="label">Claims probed</div>
            <ul className="mt-2 space-y-1 text-sm">
              <li className="flex justify-between gap-3"><span>Strong</span><strong>{p.bands.strong}</strong></li>
              <li className="flex justify-between gap-3"><span>Partial</span><strong>{p.bands.partial}</strong></li>
              <li className="flex justify-between gap-3"><span>Weak</span><strong>{p.bands.weak}</strong></li>
            </ul>
          </div>
          <div>
            <div className="label">Integrity (separate from score)</div>
            <p className="mt-2 text-sm">
              Status: <strong>{p.integrity.status}</strong>
            </p>
          </div>
        </div>
        <p className="text-xs opacity-70">
          This receipt holds no document content, answers, file name or email. The deliverable
          stays with the people it was sent to; drop it on the verify page to check it matches.
        </p>
      </div>

      <div className="panel mt-8 rounded-xl p-5">
        <h2 className="text-xl text-[var(--moss)]">Send it your way</h2>
        <p className="mt-2 text-sm text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
          Download the stamp or printable cover, attach it to the same file you
          defended, and send via email, Slack, or Docs — no new workflow for the
          receiver. They can open the verify link or drop the file to check the hash.
        </p>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <a href={`/api/stamp/${p.id}`} className="btn btn-primary" download>
            Download stamp SVG
          </a>
          <a
            href={`/api/receipts/${p.id}/cover`}
            className="btn btn-ghost"
            target="_blank"
            rel="noreferrer"
          >
            Open printable cover
          </a>
          <Link href={`/verify/${p.id}`} className="btn btn-ghost">
            Verify file hash
          </Link>
        </div>
      </div>
      <p className="mt-4 text-xs text-[color-mix(in_srgb,var(--ink)_55%,transparent)]">
        Graded with {p.modelVersions.join(", ")} · {p.rubricVersion}
      </p>
    </div>
  );
}
