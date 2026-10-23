import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { SignInCard } from "@/components/auth";
import { CreateChallengeForm } from "@/components/challenge/actions";
import { SESSION_COOKIE, getUserFromRequest } from "@/lib/auth";
import { challengesEnabled } from "@/lib/challenge-tier";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Challenge someone" };

function onwardFromQuery(value: string | string[] | undefined): "defender" | "viewer" | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "defender" || raw === "viewer") return raw;
  return undefined;
}

export default async function NewChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ onward?: string | string[] }>;
}) {
  if (!challengesEnabled()) notFound();
  const onward = onwardFromQuery((await searchParams).onward);
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const user = token
    ? await getUserFromRequest(new Request("http://internal", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))
    : null;

  return (
    <div className="shell grid max-w-2xl gap-8">
      <header className="grid max-w-[68ch] gap-4">
        <p className="eyebrow">Sponsored by DefendIT</p>
        <h1 className="type-page">Challenge someone to defend it</h1>
        <div className="grid gap-3 text-[var(--ink-2)]">
          <p>
            See a launch, repo, or bold claim you respect? Make a link and post it from your own account, under
            their post.
          </p>
          <p>
            Nothing happens unless they open it and opt in. They pick the file, can practice privately in Learn,
            then take a short text interview. They choose whether the result is public, public without the score,
            or private. If they keep it private, nothing is posted.
          </p>
        </div>
        <p className="text-sm text-[var(--ink-2)]">
          Free in beta, sponsored by DefendIT. No one is paid to accept or share.
        </p>
        <p className="text-sm">
          <Link href="/c/opt-out" className="text-[var(--blueprint)]">
            Don&apos;t challenge me again
          </Link>
        </p>
      </header>
      {user ? <CreateChallengeForm onward={onward} /> : (
        <SignInCard
          title="Sign in to create a challenge"
          next={onward ? `/c/new?onward=${onward}` : "/c/new"}
        />
      )}
    </div>
  );
}
