import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { SignInCard } from "@/components/auth";
import { OptOutForm } from "@/components/challenge/actions";
import { SESSION_COOKIE, getUserFromRequest } from "@/lib/auth";
import { challengesEnabled } from "@/lib/challenge-tier";
import { getOptOut } from "@/lib/challenges";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Don't challenge me" };

export default async function OptOutPage() {
  if (!challengesEnabled()) notFound();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const user = token
    ? await getUserFromRequest(new Request("http://internal", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))
    : null;
  if (!user) {
    return (
      <div className="shell max-w-2xl">
        <h1 className="text-3xl font-bold">Don&apos;t challenge me</h1>
        <div className="mt-8">
          <SignInCard title="Sign in to set this" next="/c/opt-out" />
        </div>
      </div>
    );
  }
  const state = await getOptOut(user);
  return (
    <div className="shell max-w-2xl">
      <h1 className="text-3xl font-bold sm:text-4xl">Don&apos;t challenge me</h1>
      <OptOutForm initialOptedOut={state.optedOut} initialHandles={state.handles} />
    </div>
  );
}
