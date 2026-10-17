"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface Detail {
  session: {
    id: string;
    creator_name: string;
    creator_email: string;
    transcript_json: string;
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
}

export default function AdminDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [score, setScore] = useState(70);
  const [notes, setNotes] = useState("");
  const [graderName, setGraderName] = useState("Luis");
  const [saved, setSaved] = useState(false);

  async function load() {
    const d = await fetch(`/api/admin/sessions/${id}`).then((r) => r.json());
    setDetail(d);
    if (d.human?.overall_score != null) setScore(d.human.overall_score);
    if (d.human?.notes) setNotes(d.human.notes);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/admin/sessions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overallScore: score, notes, graderName }),
    });
    setSaved(true);
    await load();
  }

  if (!detail) {
    return (
      <div className="shell">
        <p>Loading…</p>
      </div>
    );
  }

  const turns = JSON.parse(detail.session.transcript_json || "[]") as {
    question?: string;
    answer?: string;
    latencyMs?: number;
    role?: string;
    content?: string;
  }[];

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
      <h1 className="mt-4 text-4xl text-[var(--moss)]">Grade session</h1>
      <p className="mt-2 text-sm">
        {detail.session.creator_name} · {detail.session.creator_email}
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="panel rounded-xl p-5">
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

        <form onSubmit={save} className="panel space-y-3 rounded-xl p-5">
          <h2 className="text-xl">Human grade</h2>
          <div>
            <label className="label" htmlFor="graderName">
              Grader
            </label>
            <input
              id="graderName"
              className="field"
              value={graderName}
              onChange={(e) => setGraderName(e.target.value)}
            />
          </div>
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
        <h2 className="text-2xl text-[var(--moss)]">Transcript</h2>
        <div className="mt-4 space-y-3">
          {turns.map((t, i) => (
            <div key={i} className="panel rounded-lg p-4 text-sm">
              {t.question ? (
                <>
                  <p className="font-medium">Q: {t.question}</p>
                  <p className="mt-2">A: {t.answer}</p>
                  <p className="mt-1 text-xs opacity-60">{t.latencyMs} ms</p>
                </>
              ) : (
                <p>
                  <strong>{t.role}:</strong> {t.content}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
