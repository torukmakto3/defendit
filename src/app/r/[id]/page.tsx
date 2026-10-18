"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface ReceiptView {
  receipt: {
    payload: {
      id: string;
      score: number;
      difficulty: string;
      createdAt: string;
      creatorName: string;
      deliverable: { fileName: string; sha256: string; byteLength: number };
      bandSummary: { section: string; band: string }[];
      integrity: { status: string; observations: string[] };
      evidence: {
        band: string;
      }[];
      rubricVersion: string;
      modelVersions: string[];
    };
    signature: string;
    publicKey: string;
    verifyUrl: string;
  };
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
          <div className="label">Deliverable</div>
          <div>{p.deliverable.fileName}</div>
          <div className="mt-1 break-all font-mono text-xs">
            sha256:{p.deliverable.sha256}
          </div>
        </div>
        <div>
          <div className="label">Defended by</div>
          <div>{p.creatorName}</div>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <div className="label">Understanding</div>
            <ul className="mt-2 space-y-1 text-sm">
              {p.bandSummary.map((b) => (
                <li key={b.section} className="flex justify-between gap-3">
                  <span>{b.section}</span>
                  <strong>{b.band}</strong>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="label">Integrity (separate)</div>
            <p className="mt-2 text-sm">
              Status: <strong>{p.integrity.status}</strong>
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {p.integrity.observations.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="mt-8">
        <h2 className="text-2xl text-[var(--moss)]">Bands</h2>
        <p className="mt-2 text-sm text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
          The signed receipt records the band for each answer. The words of the
          interview stay on this account.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {p.evidence.map((e, i) => (
            <span key={i} className="panel rounded-lg px-3 py-2 text-sm">
              {i + 1}. {e.band}
            </span>
          ))}
        </div>
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
