"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
  workspaceHref: string;
}

interface Wallet {
  balance: {
    defenseOnly: number;
    challengeOnly: number;
    flex: number;
    held: { defense: number; challenge: number };
  };
  plan: { name: string; costTier: string; status: string };
  learn: { active: number; limit: number | null };
  billingEnabled: boolean;
  prices: {
    defense: string;
    challenge: string;
    pack3: string;
    pack8: string;
    subscriptionMonth: string;
    note: string;
  };
  history: { id: string; at: string; label: string; amount: number }[];
}

export default function DashboardPage() {
  const router = useRouter();
  const { me } = useMe();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    fetch("/api/dashboard", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        setRows(j.rows);
        setWallet(j.wallet ?? null);
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

      {me && wallet && <WalletPanel wallet={wallet} />}

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
                      <Link
                        href={row.workspaceHref}
                        prefetch
                        className="text-[var(--moss)] underline"
                        onMouseEnter={() => router.prefetch(row.workspaceHref)}
                      >
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

function WalletPanel({ wallet }: { wallet: Wallet }) {
  const learn =
    wallet.learn.limit == null ? String(wallet.learn.active) : `${wallet.learn.active} / ${wallet.learn.limit}`;
  const planLabel = wallet.plan.status === "active" ? wallet.plan.name : "Beta";
  return (
    <section className="panel mt-8 p-5" aria-label="Credit wallet">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold">Wallet</h2>
        <span className="eyebrow">
          {planLabel} · {wallet.plan.costTier}
        </span>
      </div>
      <p className="mt-2 text-sm text-[var(--ink-2)]">
        A defense is 1 credit ({wallet.prices.defense}). A challenge is 1 credit ({wallet.prices.challenge}).
        Packs are {wallet.prices.pack3} for 3 and {wallet.prices.pack8} for 8, usable for either. Subscription{" "}
        {wallet.prices.subscriptionMonth}/mo. {wallet.prices.note}
      </p>
      {!wallet.billingEnabled && (
        <p className="mt-2 text-sm text-[var(--ink-2)]">Billing is not enabled. Credits already on the account still spend.</p>
      )}
      <div className="titleblock mt-4">
        <div>
          <small>Defense</small>
          <b>{wallet.balance.defenseOnly}</b>
        </div>
        <div>
          <small>Challenge</small>
          <b>{wallet.balance.challengeOnly}</b>
        </div>
        <div>
          <small>Either</small>
          <b>{wallet.balance.flex}</b>
        </div>
        <div>
          <small>Learn</small>
          <b>{learn}</b>
        </div>
      </div>
      {wallet.balance.held.defense + wallet.balance.held.challenge > 0 && (
        <p className="mt-3 text-sm text-[var(--ink-2)]">
          Held: {wallet.balance.held.defense} defense, {wallet.balance.held.challenge} challenge.
        </p>
      )}
      <h3 className="mt-5 text-sm font-semibold">Ledger</h3>
      {wallet.history.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--ink-2)]">No credit activity yet.</p>
      ) : (
        <ul className="mt-2 text-sm">
          {wallet.history.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 border-t border-[var(--line)] py-2">
              <span>
                {row.label}
                <span className="mt-0.5 block text-xs text-[var(--ink-2)]">{row.at.slice(0, 16).replace("T", " ")}</span>
              </span>
              <span className="mono">{row.amount > 0 ? `+${row.amount}` : row.amount}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
