"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SignInCard, useMe } from "@/components/auth";

interface Row {
  token: string;
  title: string;
  role: "creator" | "receiver";
  difficulty: string;
  status: string;
  createdAt: string;
  receiptId: string | null;
  score: number | null;
  outcome: string | null;
}

export default function DashboardPage() {
  const { me } = useMe();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    fetch("/api/dashboard", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        setRows(j.rows);
      })
      .catch((e) => setError(e.message));
  }, [me]);

  return (
    <div className="shell max-w-4xl">
      <h1 className="text-3xl font-bold sm:text-4xl">Dashboard</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Defenses you requested and deliverables you defended.
      </p>

      {me === null && (
        <div className="mt-8">
          <SignInCard title="Sign in to see your dashboard" />
        </div>
      )}
      {error && <p className="mt-6 text-danger">{error}</p>}

      {me && (
        <div className="panel mt-8 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="mono border-b-[1.5px] border-[var(--ink)] text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">
              <tr>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Your role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3">Links</th>
              </tr>
            </thead>
            <tbody>
              {rows === null ? (
                <tr><td className="px-4 py-6" colSpan={5}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 opacity-60" colSpan={5}>Nothing yet.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.token} className="border-t border-[var(--line)]">
                    <td className="px-4 py-3">{row.title}</td>
                    <td className="px-4 py-3">{row.role}</td>
                    <td className="px-4 py-3">{row.status}</td>
                    <td className="px-4 py-3">
                      {row.score != null ? `${row.outcome} · ${row.score}/100` : "—"}
                    </td>
                    <td className="space-x-3 px-4 py-3">
                      <Link href={`/d/${row.token}`} className="text-[var(--moss)] underline">
                        Workspace
                      </Link>
                      {row.receiptId && (
                        <Link href={`/r/${row.receiptId}`} className="text-[var(--moss)] underline">
                          Receipt
                        </Link>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
