"use client";

import { useParams } from "next/navigation";
import * as ed from "@noble/ed25519";
import { useEffect, useState } from "react";
import { canonicalJson } from "@/lib/canonical";
import type { SignedReceipt } from "@/lib/types";

const fromHex = (hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

/**
 * Check the signature here in the browser against the key the server
 * publishes, instead of trusting the server's own "valid" flag.
 */
async function verifyInBrowser(receipt: SignedReceipt): Promise<boolean> {
  try {
    const published = await fetch("/.well-known/defend-it-pubkey.json").then((r) => r.json());
    if (published.publicKeyHex !== receipt.publicKey) return false;
    return await ed.verifyAsync(
      fromHex(receipt.signature),
      new TextEncoder().encode(canonicalJson(receipt.payload)),
      fromHex(receipt.publicKey),
    );
  } catch {
    return false;
  }
}

async function sha256HexBrowser(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function VerifyPage() {
  const { id } = useParams<{ id: string }>();
  const [expected, setExpected] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string>("");
  const [signatureValid, setSignatureValid] = useState<boolean | null>(null);
  const [result, setResult] = useState<"match" | "mismatch" | null>(null);
  const [gotHash, setGotHash] = useState<string | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/receipts/${id}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Not found");
        setExpected(j.receipt.payload.deliverable.sha256);
        setOutcome(j.receipt.payload.outcome);
        setScore(j.receipt.payload.score);
        setSignatureValid(await verifyInBrowser(j.receipt));
      })
      .catch((e) => setError(e.message));
  }, [id]);

  async function onFile(file: File | null) {
    if (!file || !expected) return;
    const hash = await sha256HexBrowser(file);
    setGotHash(hash);
    setResult(hash === expected ? "match" : "mismatch");
  }

  return (
    <div className="shell max-w-2xl">
      <h1 className="text-4xl text-[var(--moss)]">Verify receipt</h1>
      <p className="mt-3 text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
        Drop your copy of the file. Hashing happens in your browser — the file
        never leaves your machine.
      </p>

      {error && <p className="mt-6 text-red-700">{error}</p>}

      {expected && (
        <div className="panel mt-8 space-y-4 rounded-xl p-6">
          <p>
            Receipt: <strong>{outcome} · {score}/100</strong>
          </p>
          <p>
            Signature (checked in your browser against Defend It&apos;s published key):{" "}
            <strong>
              {signatureValid === null ? "checking…" : signatureValid ? "valid" : "invalid"}
            </strong>
          </p>
          <p className="break-all font-mono text-xs">sha256:{expected}</p>
          <input
            type="file"
            onChange={(e) => onFile(e.target.files?.[0] || null)}
          />
          {result === "match" && (
            <p className="text-lg font-medium text-[var(--moss)]">
              ✓ Matches — this is the exact defended file.
            </p>
          )}
          {result === "mismatch" && (
            <div>
              <p className="text-lg font-medium text-red-800">
                ✗ Doesn&apos;t match — the file was edited or swapped.
              </p>
              {gotHash && (
                <p className="mt-2 break-all font-mono text-xs">
                  your sha256:{gotHash}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
