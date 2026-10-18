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
      <h1 className="text-4xl text-[var(--moss)]">Admin · human grading</h1>
      <p className="mt-3 text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
        Pilot calibration: open a transcript, enter a human score, compare to the
        AI council.
      </p>
      {error && <p className="mt-6 text-red-700">{error} — admins are listed in ADMIN_EMAILS.</p>}
      <div className="mt-8 overflow-x-auto panel rounded-xl">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--line)] text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Creator</th>
              <th className="px-4 py-3">Difficulty</th>
              <th className="px-4 py-3">Human</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td className="px-4 py-6" colSpan={5}>
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
