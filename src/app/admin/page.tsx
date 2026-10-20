"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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
  over_budget: number;
  budget_usd: number;
}

function formatUsd(amount: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "$0.00";
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return `$${n.toFixed(digits)}`;
}

export default function AdminPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/sessions")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed");
        setSessions(d.sessions || []);
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="shell">
      <h1 className="text-3xl font-bold sm:text-4xl">Admin · human grading</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Pilot calibration: open a transcript, enter a human score, compare to the
        AI council.
      </p>
      {error && <p className="mt-6 text-danger">{error} — admins are listed in ADMIN_EMAILS.</p>}
      <div className="mt-8 overflow-x-auto panel">
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
                    <div>{formatUsd(s.cost_usd)}</div>
                    <div className="text-xs text-[var(--ink-2)]">
                      {s.prompt_tokens.toLocaleString()} in · {s.completion_tokens.toLocaleString()} out
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
