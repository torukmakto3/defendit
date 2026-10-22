import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { SignInCard } from "@/components/auth";
import { ClaimPanel, RevokeButton, ShareBar, SuggestedShares } from "@/components/challenge/actions";
import { SESSION_COOKIE, getUserFromRequest } from "@/lib/auth";
import { appUrl } from "@/lib/config";
import { getPublicChallenge } from "@/lib/challenges";
import { challengesEnabled } from "@/lib/challenge-tier";

export const dynamic = "force-dynamic";

async function viewer() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getUserFromRequest(new Request("http://internal", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const view = await getPublicChallenge(slug, null);
  if (!view) return { title: "Challenge" };
  return {
    title: view.subject.slice(0, 80),
    description: `${view.challengerName} challenged you to defend this. Totally optional. ${view.sponsorLabel}.`,
  };
}

function statusCopy(status: string): string | null {
  switch (status) {
    case "open":
      return null;
    case "claimed":
      return "Someone has accepted this challenge.";
    case "defended":
      return "This challenge is closed.";
    case "expired":
      return "This challenge has expired. Nothing was posted.";
    case "revoked":
      return "The challenger closed this link. Nothing was posted.";
    default:
      return "This challenge is closed.";
  }
}

export default async function ChallengePage({ params }: { params: Promise<{ slug: string }> }) {
  if (!challengesEnabled()) notFound();
  const { slug } = await params;
  const user = await viewer();
  const view = await getPublicChallenge(slug, user, { recordView: true });
  if (!view) notFound();
  const shareUrl = appUrl(`/c/${view.slug}`);
  const closed = statusCopy(view.status);

  return (
    <div className="shell max-w-2xl">
      <p className="eyebrow">{view.sponsorLabel}</p>
      <h1 className="mt-2 text-3xl font-bold sm:text-4xl">{view.subject}</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        {view.challengerName} challenged you to defend this. Totally optional. Nothing is posted unless you
        opt in and choose to share.
      </p>
      <p className="mt-3 text-[var(--ink-2)]">
        You pick the file. You can practice in Learn first, then take a short text interview grounded in that
        file. You choose public, public without the score, or private.
      </p>
      <p className="mt-3 text-sm text-[var(--ink-2)]">
        {view.sponsorLabel === "Sponsored by DefendIT"
          ? "Free in beta, sponsored by DefendIT. No one is paid to accept or share."
          : `${view.sponsorLabel}. A held credit comes back to the challenger if the result stays private, or if the link expires.`}
      </p>
      <p className="mt-3 text-sm text-[var(--ink-2)]">Difficulty: {view.difficulty}.</p>
      {view.note && <p className="mt-4">{view.note}</p>}
      {view.sourceUrl && (
        <p className="mt-3">
          <a className="text-[var(--blueprint)]" href={view.sourceUrl} rel="noopener noreferrer">
            Source
          </a>
        </p>
      )}
      {view.targetHint && (
        <p className="mt-3 text-sm text-[var(--ink-2)]">
          Named for {view.targetHint}. That is a hint, not a lock. Anyone signed in can accept.
        </p>
      )}
      {view.status === "open" && (
        <p className="mt-3 text-sm text-[var(--ink-2)]">
          Open until {new Date(view.expiresAt).toLocaleString()}.
        </p>
      )}
      {view.finishBy && view.isClaimer && view.status === "claimed" && (
        <p className="mt-3 text-sm text-[var(--ink-2)]">
          Finish by {new Date(view.finishBy).toLocaleString()}.
        </p>
      )}

      <div className="mt-8 grid gap-4">
        {view.status === "open" && !user && (
          <SignInCard title="Sign in to accept" next={`/c/${view.slug}`} />
        )}
        {view.canClaim && <ClaimPanel slug={view.slug} />}
        {view.status === "open" && user && view.claimBlock && <p>{view.claimBlock}</p>}
        {view.isClaimer && view.defensePath && view.status === "claimed" && (
          <Link href={view.defensePath} className="btn btn-primary justify-self-start">
            Continue your defense
          </Link>
        )}
        {view.needsPublishChoice && (
          <Link href={`/c/${view.slug}/publish`} className="btn btn-primary justify-self-start">
            Choose what to publish
          </Link>
        )}
        {view.resultPath && (
          <Link href={view.resultPath} className="btn btn-primary justify-self-start">
            See the result
          </Link>
        )}
        {view.creatorPrivateNote && <p>{view.creatorPrivateNote}</p>}
        {closed && !view.isClaimer && view.status !== "open" && !view.resultPath && !view.creatorPrivateNote && (
          <p>{closed}</p>
        )}
        {view.canRevoke && <RevokeButton slug={view.slug} />}
        {view.status === "open" && <SuggestedShares url={shareUrl} />}
        <ShareBar
          slug={view.slug}
          url={shareUrl}
          text="Bold launch. Want to defend it? 8 min, your own file, a receipt either way. Totally optional"
        />
        <p className="flex flex-wrap gap-4 text-sm text-[var(--ink-2)]">
          <Link href={`/c/${view.slug}/report`}>Report this challenge</Link>
          <Link href="/c/opt-out">Don&apos;t challenge me again</Link>
        </p>
      </div>
    </div>
  );
}
