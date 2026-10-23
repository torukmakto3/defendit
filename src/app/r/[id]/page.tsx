"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { beaconReceiptShared } from "@/components/analytics-beacon";
import { SignInCard } from "@/components/auth";
import { Companion } from "@/components/companion/Companion";
import { ShareBar } from "@/components/challenge/actions";
import { PublicChallengeResult } from "@/components/challenge/PublicResult";
import { LoadTest } from "@/components/receipt/LoadTest";
import { claimResults, gradedWithLine } from "@/components/receipt/metrics";
import { PlotterStamp } from "@/components/receipt/PlotterStamp";
import { ToleranceChart } from "@/components/receipt/ToleranceChart";
import { integritySummary } from "@/lib/integrity";
import type { SignedReceipt } from "@/lib/types";

interface ChallengeResultView {
  slug: string;
  audience: "public" | "defender";
  visibility: string;
  tier: string | null;
  score: number | null;
  showScore: boolean;
  headline: string;
  verifyPath: string | null;
  sponsorLabel: string;
  subject: string;
  legend: string;
  shareUrl: string;
}

function subscribeShare() {
  return () => {};
}

function shareAvailable() {
  return typeof navigator.share === "function";
}

function shareUnavailable() {
  return false;
}

interface ReceiptView {
  receipt: SignedReceipt | null;
  signatureValid: boolean | null;
  challengeResult?: ChallengeResultView | null;
}

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ReceiptView | null>(null);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canShare = useSyncExternalStore(subscribeShare, shareAvailable, shareUnavailable);

  useEffect(() => {
    fetch(`/api/receipts/${id}?view=1`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Not found");
        setData(j);
        if (j.challengeResult?.audience === "public") return;
        const labelsRes = await fetch(`/api/receipts/${id}/labels`);
        const labelsJson = labelsRes.ok ? await labelsRes.json() : { labels: null };
        setLabels(labelsJson.labels ?? null);
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

  if (data.challengeResult?.audience === "public") {
    return <PublicChallengeResult result={data.challengeResult} />;
  }
  if (!data.receipt) {
    return (
      <div className="shell">
        <p>This result is not published.</p>
      </div>
    );
  }

  const p = data.receipt.payload;
  const sample = p.demo?.sample === true;
  const defended = p.outcome === "Defended";
  const { claims, approximate } = claimResults(p, labels);

  return (
    <div className="shell grid max-w-4xl gap-8">
      <div className="grid grid-cols-[auto_1fr] items-center gap-4">
        <Companion state={defended ? "surprised" : p.outcome === "Not defended" ? "skeptical" : "listening"} size={72} />
        <div className="min-w-0 grid gap-2">
          <p className="eyebrow">{sample ? "Sample demo · not a credential" : "Understanding receipt"}</p>
          <h1 className="type-page">{sample ? "Demo on a sample file" : p.outcome}</h1>
          {sample && <p className="text-lg font-semibold">{p.outcome}</p>}
          <p className="text-sm text-[var(--ink-2)]">
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
          <h2 className="type-section">How the claims held up</h2>
          <span className="text-sm text-[var(--ink-2)]">
            {labels
              ? "Section and the quoted passage are visible only to you."
              : approximate
                ? "Approximate: this receipt predates per-claim scores."
                : "Claims are numbered; their content stays private."}
          </span>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="panel grid content-start gap-3 p-5">
            <span className="label mb-0">Load test</span>
            <p className="text-sm text-[var(--ink-2)]">Each claim is a support under the deliverable. Weak supports crack.</p>
            <LoadTest claims={claims} score={p.score} outcome={p.outcome} />
          </div>
          <div className="panel grid content-start gap-3 p-5">
            <span className="label mb-0">Tolerance chart</span>
            <p className="text-sm text-[var(--ink-2)]">Each claim&apos;s score against the spec: 50 passes, 75 is strong.</p>
            <ToleranceChart claims={claims} />
          </div>
        </div>
      </section>

      <section className="grid gap-4">
        <h2 className="type-section">Details</h2>
        <div className="titleblock" style={{ gridTemplateColumns: "1fr" }}>
          <div><small>SHA-256 of the defended file</small><b>{p.deliverable.sha256}</b></div>
          <div>
            <small>Defended by</small>
            <b>
              {sample
                ? `Nobody. This is a demo on ${p.demo?.file ?? "a sample file"}, not a credential.`
                : p.creator
                  ? `${p.creator.displayName} (self-reported name, verified email sign-in)`
                  : "Not disclosed by the creator"}
            </b>
          </div>
          <div><small>Integrity (reported separately from the score)</small><b>{integritySummary(p.integrity)}</b></div>
          <div><small>Receipt</small><b>{p.id} &middot; rubric {p.rubricVersion}</b></div>
        </div>
        <p className="text-sm text-[var(--ink-2)]">
          This receipt holds no document content, answers, file name or email. The deliverable stays
          with the people it was sent to; drop it on the verify page to check it matches.
        </p>
      </section>

      {data.challengeResult &&
        (data.challengeResult.visibility === "public" || data.challengeResult.visibility === "score_hidden") && (
          <div className="panel grid gap-4 p-5">
            <h2 className="type-section">Share the result</h2>
            <p className="text-sm text-[var(--ink-2)]">
              Your post, if you want one. Edit it on X before it goes out. Sharing does not change the result
              or your credit.
            </p>
            <ShareBar
              slug={data.challengeResult.slug}
              url={data.challengeResult.shareUrl}
              text={defenderShareText(data.challengeResult)}
            />
            <Link href="/c/new?onward=defender" className="text-sm text-[var(--blueprint)]">
              Defended mine. Pass a challenge on.
            </Link>
          </div>
        )}
      {data.challengeResult?.visibility === "private" && (
        <p className="text-sm text-[var(--ink-2)]">You kept this private. Nothing is posted.</p>
      )}

      {sample ? (
        <div className="grid gap-4">
          <div className="panel grid gap-3 p-5">
            <h2 className="type-section">Demo on a sample file. Not a credential.</h2>
            <p className="text-sm text-[var(--ink-2)]">
              This interview used a bundled file, {p.demo?.file}. It does not show that you understand
              your own work. Answers are deleted on the same schedule as any defense, and this demo
              receipt is removed after a day. It is not listed anywhere.
            </p>
            <Link href={`/verify/${p.id}`} className="btn btn-ghost w-full justify-self-start sm:w-auto">
              Check the sample hash
            </Link>
          </div>
          <SignInCard title="Sign in and defend your own file (3 free)" />
        </div>
      ) : (
      <div className="panel grid gap-4 p-5">
        <h2 className="type-section">Send it your way</h2>
        <p className="text-sm text-[var(--ink-2)]">
          Attach the receipt PDF to the file you defended, or paste the stamp image into your email,
          Slack or Docs. The receiver scans the code or opens the link and drops their copy of the
          file to check it. No account needed.
        </p>
        <div className="grid gap-3">
          <a href={`/api/receipts/${p.id}/pdf`} className="btn btn-primary w-full justify-self-start sm:w-auto">
            Download receipt (PDF)
          </a>
          <div className="flex flex-wrap gap-3">
            <a href={`/api/stamp/${p.id}?format=png&download=1`} className="btn btn-ghost">
              Download stamp image (PNG)
            </a>
            <Link href={`/verify/${p.id}`} className="btn btn-ghost">
              Verify file hash
            </Link>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                void navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => {
                    setCopied(true);
                    beaconReceiptShared("copy");
                  })
                  .catch(() => {});
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            {canShare && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  void navigator
                    .share({ title: "Defend It receipt", url: window.location.href })
                    .then(() => beaconReceiptShared("share"))
                    .catch(() => {});
                }}
              >
                Share
              </button>
            )}
          </div>
        </div>
      </div>
      )}
      <p className="text-sm text-[var(--ink-2)]">{gradedWithLine(p)}</p>
    </div>
  );
}

function defenderShareText(result: ChallengeResultView): string {
  if (result.visibility !== "public") {
    return "Took the DefendIT challenge on my write-up. Keeping the score private.";
  }
  if (result.tier === "Strong") {
    return "Challenge accepted, challenge defended. Strong on my own file, signed and bound to the exact file. Verify it yourself.";
  }
  if (result.tier === "Still sharpening") {
    return "Took the challenge. Still sharpening. Learned more in 8 minutes than in a week of tweaking. Round two soon.";
  }
  return "Someone challenged me, so I defended it. Receipt below, hash-checked. Who's next?";
}
