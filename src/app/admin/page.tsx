"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FunnelReport, FunnelStep } from "@/lib/analytics";

interface SessionRow {
  id: string;
  creator_email: string;
  status: string;
  title: string;
  difficulty: string;
  receipt_id: string | null;
  human_score: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  llm_cost_usd: number;
  voice_cost_usd: number;
  total_cost_usd: number;
  over_budget: number;
  budget_usd: number;
  cost_tier: string;
  budget_capped: number;
}

interface CostSummary {
  count: number;
  cappedCount: number;
  p50Usd: number;
  p90Usd: number;
  maxUsd: number;
  llmUsd: number;
  voiceUsd: number;
}

function formatUsd(amount: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "$0.00";
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return `$${n.toFixed(digits)}`;
}

function formatPercent(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

function formatK(value: number | null): string {
  if (value == null) return "—";
  return value.toFixed(2);
}

function FunnelTable({ steps }: { steps: FunnelStep[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="mono border-b-[1.5px] border-[var(--ink)] text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">
        <tr>
          <th className="px-4 py-3">Step</th>
          <th className="px-4 py-3">Count</th>
          <th className="px-4 py-3">From previous</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step) => (
          <tr key={step.event} className="border-t border-[var(--line)]">
            <td className="px-4 py-3">{step.label}</td>
            <td className="px-4 py-3">{step.count}</td>
            <td className="px-4 py-3">{formatPercent(step.conversion)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AdminPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [funnel, setFunnel] = useState<FunnelReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/sessions")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed");
        setSessions(d.sessions || []);
        setSummary(d.summary ?? null);
      })
      .catch((e) => setError(e.message));
    fetch("/api/admin/funnel")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed");
        setFunnel(d);
      })
      .catch((e) => setError((prev) => prev ?? e.message));
  }, []);

  return (
    <div className="shell">
      <h1 className="text-3xl font-bold sm:text-4xl">Admin · human grading</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Pilot calibration: open a transcript, enter a human score, compare to the
        AI council.
      </p>
      {error && <p className="mt-6 text-danger">{error} — admins are listed in ADMIN_EMAILS.</p>}
      <section className="mt-8">
        <h2 className="text-2xl font-bold">Funnel · last {funnel?.days ?? 7} days</h2>
        <p className="mt-2 text-sm text-[var(--ink-2)]">
          Event counts, not people. Acceptance is accepted ÷ opened. Completion is completed ÷
          accepted. Share-back is shared ÷ completed. Onward k is new challenges from a defender or
          a viewer of a shared card ÷ completions. Sample demos are not in these steps.
        </p>
        {funnel && (
          <p className="mt-2 text-sm text-[var(--ink-2)]">
            Sample demo: {funnel.demo.started} started, {funnel.demo.completed} completed,{" "}
            {(funnel.demo.budget_cents / 100).toFixed(2)} EUR of the beta budget.
          </p>
        )}
        {!funnel && !error ? (
          <p className="mt-4 text-sm text-[var(--ink-2)]">Loading funnel…</p>
        ) : funnel ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto panel">
              <h3 className="px-4 pt-4 text-sm font-semibold">Product</h3>
              <FunnelTable steps={funnel.product} />
            </div>
            <div className="overflow-x-auto panel">
              <h3 className="px-4 pt-4 text-sm font-semibold">Challenges</h3>
              <FunnelTable steps={funnel.challenge} />
              <p className="px-4 py-3 text-sm text-[var(--ink-2)]">
                Declined {funnel.declined.count} ({formatPercent(funnel.declined.conversion)} of opens).
                Onward k {formatK(funnel.onwardK)} ({funnel.onwardCount} onward). Self{" "}
                {funnel.selfChallenges} · third-party {funnel.thirdPartyChallenges}
                {funnel.unspecifiedChallenges > 0 ? ` · unspecified ${funnel.unspecifiedChallenges}` : ""}.
              </p>
            </div>
          </div>
        ) : null}
      </section>
      {summary && (
        <div className="mt-8 grid gap-3 sm:grid-cols-4">
          <div className="panel p-4">
            <div className="mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">
              Last {summary.count} defenses
            </div>
            <div className="mt-2 text-2xl font-bold">{formatUsd(summary.p50Usd)}</div>
            <div className="text-sm text-[var(--ink-2)]">median total</div>
          </div>
          <div className="panel p-4">
            <div className="mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">p90 / max</div>
            <div className="mt-2 text-2xl font-bold">{formatUsd(summary.p90Usd)}</div>
            <div className="text-sm text-[var(--ink-2)]">max {formatUsd(summary.maxUsd)}</div>
          </div>
          <div className="panel p-4">
            <div className="mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">LLM vs voice</div>
            <div className="mt-2 text-sm">
              <div>LLM {formatUsd(summary.llmUsd)}</div>
              <div>Voice {formatUsd(summary.voiceUsd)}</div>
            </div>
          </div>
          <div className="panel p-4">
            <div className="mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">Capped</div>
            <div className="mt-2 text-2xl font-bold">{summary.cappedCount}</div>
            <div className="text-sm text-[var(--ink-2)]">defenses stopped at the cap</div>
          </div>
        </div>
      )}
      <p className="mt-4 text-sm">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- CSV file download, not an app page */}
        <a href="/api/admin/sessions?format=csv" className="text-[var(--moss)] underline">
          Download CSV
        </a>
      </p>
      <div className="mt-4 overflow-x-auto panel">
        <table className="w-full text-left text-sm">
          <thead className="mono border-b-[1.5px] border-[var(--ink)] text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Creator</th>
              <th className="px-4 py-3">Difficulty</th>
              <th className="px-4 py-3">Cost</th>
              <th className="px-4 py-3">Human</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td className="px-4 py-6" colSpan={6}>
                  No defend sessions yet.
                </td>
              </tr>
            ) : (
              sessions.map((s) => (
                <tr key={s.id} className="border-t border-[var(--line)]">
                  <td className="px-4 py-3">{s.title}</td>
                  <td className="px-4 py-3">
                    <div className="text-xs opacity-70">{s.creator_email}</div>
                  </td>
                  <td className="px-4 py-3">{s.difficulty}</td>
                  <td className="px-4 py-3">
                    <div>{formatUsd(s.total_cost_usd)}</div>
                    <div className="text-xs text-[var(--ink-2)]">
                      LLM {formatUsd(s.llm_cost_usd)} · voice {formatUsd(s.voice_cost_usd)}
                    </div>
                    <div className="text-xs text-[var(--ink-2)]">
                      {s.cost_tier} cap {formatUsd(s.budget_usd)}
                      {s.budget_capped === 1 ? " · capped" : ""}
                    </div>
                    {s.over_budget === 1 && (
                      <div className="text-xs text-danger">Over {formatUsd(s.budget_usd)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {s.human_score != null ? s.human_score : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/${s.id}`}
                      className="text-[var(--moss)] underline"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
