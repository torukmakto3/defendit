"use client";

import Link from "next/link";
import { ShareBar } from "@/components/challenge/actions";

export interface PublicResultProps {
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

/**
 * Public challenge result. Renders the tier, and the score only when the
 * defender published it. No claim text, transcript, or document body.
 */
export function PublicChallengeResult({ result }: { result: PublicResultProps }) {
  const shareText =
    result.showScore && result.score != null
      ? `Defended · ${result.tier}. Score ${result.score}/100.`
      : `Defended · ${result.tier ?? "Defended"}. The score is not shown.`;

  return (
    <div className="shell max-w-2xl">
      <p className="eyebrow">{result.sponsorLabel}</p>
      {result.sponsorLabel === "Sponsored by DefendIT" && (
        <p className="mt-3 text-sm text-[var(--ink-2)]">Free in beta. No one is paid to share.</p>
      )}
      {result.visibility === "score_hidden" && (
        <p className="mt-3 text-sm font-semibold uppercase tracking-[0.08em]">Defended</p>
      )}
      <h1 className="mt-2 text-3xl font-bold sm:text-4xl">{result.tier ?? result.headline}</h1>
      {result.showScore && result.score != null && (
        <p className="mt-3 text-lg">Score {result.score}/100</p>
      )}
      {result.visibility === "score_hidden" && (
        <p className="mt-3 text-[var(--ink-2)]">The score is not shown.</p>
      )}
      <p className="mt-3 text-sm text-[var(--ink-2)]">{result.legend}</p>
      <p className="mt-4 text-[var(--ink-2)]">{result.subject}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        {result.verifyPath && (
          <Link href={result.verifyPath} className="btn btn-primary">
            Verify receipt
          </Link>
        )}
        <Link href="/c/new" className="btn btn-ghost">
          Challenge someone
        </Link>
        <Link href="/" className="btn btn-ghost">
          Defend your own
        </Link>
      </div>
      <div className="mt-6">
        <ShareBar slug={result.slug} url={result.shareUrl} text={shareText} />
      </div>
      <p className="mt-6 text-sm">
        <Link href={`/c/${result.slug}/report`} className="text-[var(--ink-2)]">
          Report this challenge
        </Link>
      </p>
    </div>
  );
}
