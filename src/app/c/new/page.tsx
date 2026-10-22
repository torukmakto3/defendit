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

export default async function NewChallengePage() {
  if (!challengesEnabled()) notFound();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const user = token
    ? await getUserFromRequest(new Request("http://internal", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))
    : null;

  return (
    <div className="shell max-w-2xl">
      <p className="eyebrow">Sponsored by DefendIT</p>
      <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Challenge someone to defend it</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        You get a link. The first person to accept uploads and defends, at no cost to them. They choose
        whether the result is public.
      </p>
      <p className="mt-3 text-sm">
        <Link href="/c/opt-out" className="text-[var(--blueprint)]">
          Don&apos;t challenge me
        </Link>
      </p>
      {user ? <CreateChallengeForm /> : (
        <div className="mt-8">
          <SignInCard title="Sign in to create a challenge" next="/c/new" />
        </div>
      )}
    </div>
  );
}
