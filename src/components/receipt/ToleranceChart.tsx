"use client";

import { useEffect, useRef } from "react";
import type { ClaimResult } from "./metrics";

/**
 * Quality-control sheet: each claim's score on a 0-100 axis against the
 * spec (50+ passes, 75+ is strong). Out-of-spec claims are called out.
 */
export function ToleranceChart({ claims }: { claims: ClaimResult[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.classList.add("playing");
  }, []);

  const x0 = 170;
  const x1 = 500;
  const X = (v: number) => x0 + ((x1 - x0) * v) / 100;
  const rowH = 30;
  const top = 34;
  const height = top + claims.length * rowH + 24;
  const inSpec = claims.filter((c) => c.score >= 50).length;

  return (
    <div ref={ref} className="metric">
      <svg viewBox={`0 0 520 ${height}`} role="img" aria-label={`Tolerance chart: ${inSpec} of ${claims.length} claims in spec`}>
        <rect x={X(50)} y={top - 10} width={X(100) - X(50)} height={claims.length * rowH} style={{ fill: "var(--ok)", opacity: 0.1 }} />
        <rect x={X(75)} y={top - 10} width={X(100) - X(75)} height={claims.length * rowH} style={{ fill: "var(--ok)", opacity: 0.12 }} />
        {[0, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={X(v)} y1={top - 10} x2={X(v)} y2={top - 10 + claims.length * rowH} style={{ stroke: v === 50 ? "var(--ink)" : "var(--line)" }} strokeWidth={1} strokeDasharray={v === 75 ? "4 3" : undefined} />
            <text x={X(v)} y={top - 16} textAnchor="middle" fontSize="9" style={{ fill: "var(--ink-2)", fontFamily: "var(--font-mono)" }}>
              {v === 50 ? "SPEC 50" : v}
            </text>
          </g>
        ))}
        {claims.map((c, i) => {
          const y = top + i * rowH;
          const out = c.score < 50;
          return (
            <g key={i}>
              <text x={0} y={y + 4} fontSize="12" style={{ fill: "var(--ink)", fontFamily: "var(--font-body)" }}>
                {c.label.length > 22 ? `${c.label.slice(0, 21)}…` : c.label}
              </text>
              <line x1={x0} y1={y} x2={x1} y2={y} style={{ stroke: "var(--line)" }} strokeWidth={1} />
              <g className="m-mark" style={{ ["--to" as string]: `${X(c.score) - x0}px`, ["--at" as string]: `${0.1 * i}s` }}>
                <path d={`M${x0} ${y - 7} l7 7 l-7 7 l-7 -7 Z`} style={{ fill: out ? "var(--signal)" : "var(--ok)" }} />
              </g>
              <text className="m-late" x={x1 + 4} y={y + 4} fontSize="10" style={{ fill: out ? "var(--signal)" : "var(--ink-2)", fontFamily: "var(--font-mono)" }}>
                {c.score}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-2 text-sm font-semibold">
        {inSpec} of {claims.length} claims in spec
        {inSpec < claims.length ? " · revisit the ones marked in orange" : ""}
      </p>
    </div>
  );
}
