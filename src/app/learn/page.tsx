"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SignInCard, useMe } from "@/components/auth";
import { Companion } from "@/components/companion/Companion";
import { studyFileMissingMessage } from "@/lib/study-file";

interface Project {
  token: string;
  title: string;
  status: string;
  difficulty: string;
  claimCount: number;
  createdAt: string;
  documentAvailable: boolean;
  purged: boolean;
  cards: number;
  due: number;
}

export default function LearnHubPage() {
  const { me } = useMe();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/learn/projects", { cache: "no-store" });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "Could not load projects");
    setProjects(j.projects);
  }, []);

  useEffect(() => {
    if (me) load().catch((e) => setError(e.message));
  }, [me, load]);

  const totalDue = projects?.reduce((n, p) => n + p.due, 0) ?? 0;

  return (
    <div className="shell grid gap-8">
      <section className="grid items-center gap-5 sm:grid-cols-[auto_1fr_auto]">
        <Companion state={totalDue > 0 ? "listening" : "impressed"} size={72} />
        <div className="min-w-0">
          <span className="eyebrow">Sheet 02 &middot; Learn</span>
          <h1 className="text-3xl font-bold sm:text-4xl">Your projects</h1>
          <p className="text-[var(--ink-2)]">
            Flashcards come first, made from your file. The coach and a defense are there when you want them.
          </p>
        </div>
        {totalDue > 0 && (
          <Link href="/learn/review" className="btn btn-primary">
            Review {totalDue} due {totalDue === 1 ? "card" : "cards"}
          </Link>
        )}
      </section>

      {me === null && <SignInCard title="Sign in to see your projects" />}
      {error && <p className="text-sm text-danger">{error}</p>}

      {me && projects?.length === 0 && (
        <div className="panel grid gap-3 p-6">
          <p className="font-semibold">No projects yet.</p>
          <p className="text-[var(--ink-2)]">Drop a deliverable on the home page to start a project.</p>
          <Link href="/" className="btn btn-primary justify-self-start">
            Drop a deliverable
          </Link>
        </div>
      )}

      {me && projects && projects.length > 0 && (
        <ul className="grid gap-5 md:grid-cols-2">
          {projects.map((p) => (
            <li key={p.token} className="panel grid content-start gap-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="min-w-0 text-xl font-bold [overflow-wrap:anywhere]">{p.title}</h2>
                <span className="mono border-[1.5px] border-[var(--ink)] px-2 py-0.5 text-[11px] uppercase tracking-[0.08em]">
                  {p.status}
                </span>
              </div>
              <div className="titleblock">
                <div><small>Claims</small><b>{p.claimCount}</b></div>
                <div><small>Cards</small><b>{p.cards}</b></div>
                <div><small>Due now</small><b>{p.due}</b></div>
              </div>
              {p.purged && <p className="text-sm text-[var(--ink-2)]">This upload expired and its content was deleted.</p>}
              {!p.documentAvailable && p.cards === 0 && (
                <p className="text-sm text-[var(--ink-2)]">{studyFileMissingMessage(p.status)}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {(p.documentAvailable || p.cards > 0) && !p.purged && (
                  <Link href={`/d/${p.token}/learn`} className="btn btn-primary">
                    Flashcards{p.due > 0 ? ` · ${p.due} due` : ""}
                  </Link>
                )}
                {!p.documentAvailable && (p.cards === 0 || p.purged) && (
                  <Link href={`/d/${p.token}/learn`} className="btn btn-primary">
                    Upload to study
                  </Link>
                )}
                {p.documentAvailable && (
                  <Link href={`/d/${p.token}/learn/coach`} className="btn btn-ghost">
                    Talk it through
                  </Link>
                )}
                {p.status !== "defended" && !p.purged && (
                  <Link href={`/d/${p.token}/defend`} className="btn btn-ghost">
                    Defend
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
