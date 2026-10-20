"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface Detail {
  session: {
    id: string;
    creator_name: string | null;
    creator_email: string;
    transcript: { question?: string; answer?: string; latencyMs?: number }[] | null;
    purged: boolean;
  };
  grades: {
    modelId: string;
    provider: string;
    overallScore: number;
  }[];
  human?: {
    overall_score: number;
    notes: string | null;
    grader_name: string;
  };
  receipt: {
    payload: { id: string; score: number };
  } | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    overBudget: boolean;
    budgetUsd: number;
    calls: {
      id: string;
      purpose: string | null;
      provider: string;
      modelId: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      costSource: "provider" | "estimated";
    }[];
  };
}

function formatUsd(amount: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "$0.00";
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return `$${n.toFixed(digits)}`;
}

export default function AdminDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [score, setScore] = useState(70);
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/sessions/${id}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Failed");
    return d as Detail;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        if (d.human?.overall_score != null) setScore(d.human.overall_score);
        if (d.human?.notes) setNotes(d.human.notes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/admin/sessions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overallScore: score, notes }),
    });
    setSaved(true);
    const d = await load();
    setDetail(d);
    if (d.human?.overall_score != null) setScore(d.human.overall_score);
    if (d.human?.notes) setNotes(d.human.notes);
  }

  if (!detail) {
    return (
      <div className="shell">
        <p>Loading…</p>
      </div>
    );
  }

  const turns = detail.session.transcript ?? [];

  const aiAvg =
    detail.grades.length === 0
      ? null
      : Math.round(
          detail.grades.reduce((s, g) => s + g.overallScore, 0) /
            detail.grades.length,
        );

  return (
    <div className="shell max-w-4xl">
      <Link href="/admin" className="text-sm text-[var(--moss)] underline">
        ← Admin list
      </Link>
      <h1 className="mt-4 text-3xl font-bold sm:text-4xl">Grade session</h1>
      <p className="mt-2 text-sm">
        {detail.session.creator_name ?? "—"} · {detail.session.creator_email}
      </p>

      <div className="mt-8 panel p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl">Model usage</h2>
          {detail.usage.overBudget && (
            <span className="text-sm text-danger">Over {formatUsd(detail.usage.budgetUsd)} budget</span>
          )}
        </div>
        <p className="mt-2 text-sm">
          <strong>{formatUsd(detail.usage.costUsd)}</strong>
          {" · "}
          {detail.usage.promptTokens.toLocaleString()} prompt tokens
          {" · "}
          {detail.usage.completionTokens.toLocaleString()} completion tokens
          {" · "}
          budget {formatUsd(detail.usage.budgetUsd)}
        </p>
        {detail.usage.calls.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-2)]">
                <tr>
                  <th className="py-2 pr-3">Call</th>
                  <th className="py-2 pr-3">Model</th>
                  <th className="py-2 pr-3">Tokens</th>
                  <th className="py-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.usage.calls.map((call) => (
                  <tr key={call.id} className="border-t border-[var(--line)]">
                    <td className="py-2 pr-3">{call.purpose ?? "model call"}</td>
                    <td className="py-2 pr-3">
                      {call.provider}:{call.modelId}
                    </td>
                    <td className="py-2 pr-3">
                      {call.promptTokens.toLocaleString()} / {call.completionTokens.toLocaleString()}
                    </td>
                    <td className="py-2">
                      {formatUsd(call.costUsd)}
                      <span className="ml-2 text-xs text-[var(--ink-2)]">{call.costSource}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="panel p-5">
          <h2 className="text-xl">AI council</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.grades.map((g) => (
              <li key={g.modelId} className="flex justify-between gap-3">
                <span>
                  {g.provider}:{g.modelId}
                </span>
                <strong>{g.overallScore}</strong>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm">
            Average: <strong>{aiAvg ?? "—"}</strong>
            {detail.human && (
              <>
                {" "}
                · Human: <strong>{detail.human.overall_score}</strong> · Δ{" "}
                <strong>
                  {aiAvg != null
                    ? Math.abs(aiAvg - detail.human.overall_score)
                    : "—"}
                </strong>
              </>
            )}
          </p>
          {detail.receipt && (
            <Link
              href={`/r/${detail.receipt.payload.id}`}
              className="mt-4 inline-block text-[var(--moss)] underline"
            >
              Open receipt
            </Link>
          )}
        </div>

        <form onSubmit={save} className="panel space-y-3 p-5">
          <h2 className="text-xl">Human grade</h2>
          <div>
            <label className="label" htmlFor="score">
              Score 0–100
            </label>
            <input
              id="score"
              type="number"
              min={0}
              max={100}
              className="field"
              value={score}
              onChange={(e) => setScore(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="notes">
              Notes
            </label>
            <textarea
              id="notes"
              className="field min-h-24"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary">
            Save human grade
          </button>
          {saved && <p className="text-sm text-[var(--leaf)]">Saved.</p>}
        </form>
      </div>

      <div className="mt-8">
        <h2 className="text-2xl font-bold">Transcript</h2>
        {detail.session.purged && (
          <p className="mt-2 text-sm opacity-70">Transcript deleted after the retention window.</p>
        )}
        <div className="mt-4 space-y-3">
          {turns.map((t, i) => (
            <div key={i} className="panel p-4 text-sm">
              <p className="font-medium">Q: {t.question}</p>
              <p className="mt-2">A: {t.answer}</p>
              <p className="mt-1 text-xs opacity-60">{t.latencyMs} ms</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
