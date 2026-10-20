"use client";

import { useEffect, useRef } from "react";
import type { ClaimResult } from "./metrics";

const FILL = { strong: "var(--ok)", partial: "var(--warn)", weak: "var(--signal)" } as const;

/**
 * Each probed claim is a support under the deliverable. The load drops,
 * supports rise to their strength, weak ones crack, and the beam sags in
 * proportion to the overall shortfall.
 */
export function LoadTest({ claims, score, outcome }: { claims: ClaimResult[]; score: number; outcome: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.classList.add("playing");
  }, []);

  const n = Math.max(1, claims.length);
  const left = 60;
  const span = 400;
  const step = span / n;
  const sag = Math.round(((100 - score) / 100) * 14);
  const verdict =
    outcome === "Defended" ? "Holds under load" : outcome === "Partially defended" ? "Holds with strain" : "Fails under load";

  return (
    <div ref={ref} className="metric">
      <svg viewBox="0 0 520 250" role="img" aria-label={`Load test: ${verdict}. ${claims.map((c) => `${c.label} ${c.band}`).join(", ")}`}>
        <line x1="20" y1="214" x2="500" y2="214" style={{ stroke: "var(--ink)" }} strokeWidth={2} />
        {Array.from({ length: 34 }, (_, i) => (
          <line key={i} x1={24 + i * 14} y1={214} x2={16 + i * 14} y2={224} style={{ stroke: "var(--line)" }} strokeWidth={1} />
        ))}
        <g className="m-load">
          <path d="M250 14 L270 14 L270 38 L282 38 L260 58 L238 38 L250 38 Z" style={{ fill: "var(--blueprint)" }} />
          <text x="290" y="34" fontSize="10" style={{ fill: "var(--ink-2)", fontFamily: "var(--font-mono)" }}>YOUR DELIVERABLE</text>
        </g>
        <g className="m-beam" style={{ ["--sag" as string]: `${sag}px` }}>
          <rect x="40" y="86" width="440" height="20" style={{ fill: "var(--card)", stroke: "var(--ink)" }} strokeWidth={2} />
        </g>
        {claims.map((c, i) => {
          const cx = left + step * (i + 0.5);
          const w = c.band === "strong" ? 22 : c.band === "partial" ? 16 : 11;
          const top = 106 + sag;
          return (
            <g key={i}>
              <rect className="m-pillar" x={cx - w / 2} y={top} width={w} height={214 - top} style={{ fill: FILL[c.band], ["--at" as string]: `${0.12 * i}s` }} />
              {c.band === "weak" && (
                <path className="m-crack" d={`M${cx + w / 2 + 3} ${top + 24} l6 10 l-5 8 l7 12 l-4 9`} fill="none" strokeWidth={2} style={{ stroke: "var(--signal)" }} />
              )}
              <text x={cx} y={238} textAnchor="middle" fontSize="9" style={{ fill: "var(--ink-2)", fontFamily: "var(--font-mono)" }}>
                <title>{c.label}</title>
                {c.label.length > Math.floor(step / 7) ? `${c.label.slice(0, Math.max(3, Math.floor(step / 7) - 1))}…` : c.label}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-2 text-sm font-semibold">
        {verdict} &middot; {claims.filter((c) => c.band === "weak").length} weak support
        {claims.filter((c) => c.band === "weak").length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
