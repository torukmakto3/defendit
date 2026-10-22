import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { SignInCard } from "@/components/auth";
import { PublishChoice } from "@/components/challenge/actions";
import { SESSION_COOKIE, getUserFromRequest } from "@/lib/auth";
import { challengesEnabled, TIER_LEGEND } from "@/lib/challenge-tier";
import { getDefenderPreview } from "@/lib/challenges";
import { HttpError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function PublishPage({ params }: { params: Promise<{ slug: string }> }) {
  if (!challengesEnabled()) notFound();
  const { slug } = await params;
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const user = token
    ? await getUserFromRequest(new Request("http://internal", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))
    : null;
  if (!user) {
    return (
      <div className="shell max-w-2xl">
        <SignInCard title="Sign in to choose" next={`/c/${slug}/publish`} />
      </div>
    );
  }
  let preview;
  try {
    preview = await getDefenderPreview(slug, user);
  } catch (e) {
    if (e instanceof HttpError) notFound();
    throw e;
  }

  return (
    <div className="shell max-w-2xl">
      <p className="eyebrow">Your result</p>
      <h1 className="mt-2 text-3xl font-bold">{preview.tier}</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Score {preview.score}/100 · {preview.outcome}
      </p>
      <p className="mt-2 text-sm text-[var(--ink-2)]">{TIER_LEGEND}</p>
      <p className="mt-4">{preview.subject}</p>
      <div className="mt-8">
        <PublishChoice
          slug={preview.slug}
          score={preview.score}
          tier={preview.tier}
          already={preview.visibility}
        />
      </div>
      <p className="mt-6 text-sm">
        <Link href={preview.receiptPath} className="text-[var(--blueprint)]">
          Open your receipt
        </Link>
      </p>
    </div>
  );
}
