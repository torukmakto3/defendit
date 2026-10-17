"use client";

import Link from "next/link";
import { useState } from "react";

interface Item {
  id: string;
  token: string;
  title: string;
  difficulty: string;
  status: string;
  createdAt: string;
  receiptId: string | null;
  score: number | null;
}

export default function DashboardPage() {
  const [email, setEmail] = useState("alex@fund.example");
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    const res = await fetch(`/api/dashboard?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed");
      return;
    }
    setItems(data.items);
  }

  return (
    <div className="shell">
      <h1 className="text-4xl text-[var(--moss)]">Receiver dashboard</h1>
      <p className="mt-3 text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
        Defense requests you created and their results.
      </p>

      <form onSubmit={load} className="mt-8 flex flex-wrap gap-3">
        <input
          className="field max-w-sm"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="receiver@company.com"
        />
        <button type="submit" className="btn btn-primary">
          Load
        </button>
        <Link href="/request" className="btn btn-ghost">
          New request
        </Link>
      </form>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      <div className="mt-8 overflow-x-auto panel rounded-xl">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--line)] text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Difficulty</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Links</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-[color-mix(in_srgb,var(--ink)_55%,transparent)]" colSpan={5}>
                  No requests yet for this email.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-t border-[var(--line)]">
                  <td className="px-4 py-3">{item.title}</td>
                  <td className="px-4 py-3">{item.difficulty}</td>
                  <td className="px-4 py-3">{item.status}</td>
                  <td className="px-4 py-3">
                    {item.score != null ? `${item.score}/100` : "—"}
                  </td>
                  <td className="px-4 py-3 space-x-3">
                    <Link href={`/d/${item.token}`} className="text-[var(--moss)] underline">
                      Creator link
                    </Link>
                    {item.receiptId && (
                      <Link
                        href={`/r/${item.receiptId}`}
                        className="text-[var(--moss)] underline"
                      >
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
    </div>
  );
}
