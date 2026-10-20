"use client";

import { useEffect, useRef } from "react";

export type CompanionState = "listening" | "thinking" | "speaking" | "skeptical" | "surprised" | "impressed";

/**
 * The Titleblock robot (see DESIGN.md). Pure SVG + CSS: states are CSS poses
 * keyed on data-state; pupils follow the pointer through two CSS variables,
 * written outside React so tracking never re-renders.
 */
export function Companion({
  state = "listening",
  size = 84,
  className = "",
}: {
  state?: CompanionState;
  size?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const d = Math.max(1, Math.hypot(dx, dy));
        const k = Math.min(3, d / 80);
        el.style.setProperty("--mx", `${((dx / d) * k).toFixed(2)}px`);
        el.style.setProperty("--my", `${((dy / d) * k).toFixed(2)}px`);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <span ref={ref} className={`companion ${className}`} data-state={state} aria-hidden="true">
      <svg viewBox="0 0 84 84" width={size} height={size}>
        <g className="c-body">
          <g className="c-frame">
            <line x1="42" y1="6" x2="42" y2="14" />
            <rect x="10" y="14" width="64" height="48" rx="10" />
            <path d="M26 62 L22 76 M58 62 L62 76" />
            <path className="c-mouth" d="M34 53 L50 53" />
          </g>
          <circle className="c-antenna-light" cx="42" cy="5" r="2.8" />
          <g className="c-brows c-frame">
            <path d="M20 19 L36 19" />
            <path className="c-brow-flat" d="M48 19 L64 19" />
            <path className="c-brow-skep" d="M48 21 L64 15" />
          </g>
          <g className="c-eyes">
            <rect className="c-eye c-eye-l" x="18" y="25" width="20" height="16" rx="3" />
            <rect className="c-eye c-eye-r" x="46" y="25" width="20" height="16" rx="3" />
          </g>
          <g className="c-pupils">
            <rect className="c-pupil" x="25" y="30" width="6" height="6" />
            <rect className="c-pupil" x="53" y="30" width="6" height="6" />
          </g>
          <path className="c-happy" d="M20 36 L28 28 L36 36 M48 36 L56 28 L64 36" />
        </g>
      </svg>
    </span>
  );
}
