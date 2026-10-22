import QRCode from "qrcode";
import { escapeHtml } from "./escape";
import type { ReceiptPayload } from "./types";

/**
 * The "plotter print" stamp (DESIGN.md): frame, outcome, title block, a QR
 * cell, and an APPROVED stamp when defended. One generator serves:
 * - the downloadable PNG (static, day palette, it travels in email and PDFs)
 * - the receipt page (themed via CSS variables, animated by the page)
 * The QR is always dark on white so it scans in either theme.
 */
type StampPayload = Pick<ReceiptPayload, "score" | "difficulty" | "outcome"> &
  Partial<Pick<ReceiptPayload, "bands" | "integrity" | "rubricVersion" | "deliverable" | "createdAt" | "demo">>;

const DAY = {
  sheet: "#F5F7FA",
  grid: "#DDE4EE",
  card: "#FFFFFF",
  ink: "#0E1726",
  ink2: "#4A5568",
  blue: "#1F4BD8",
  signal: "#C2410C",
};
const THEMED = {
  sheet: "var(--card)",
  grid: "var(--grid)",
  card: "var(--card)",
  ink: "var(--ink)",
  ink2: "var(--ink-2)",
  blue: "var(--blueprint)",
  signal: "var(--signal)",
};

const MONO = "JetBrains Mono, ui-monospace, Menlo, monospace";
const DISPLAY = "Sora, Helvetica, Arial, sans-serif";

export async function generateStampSvg(opts: {
  payload: StampPayload;
  verifyUrl: string;
  themed?: boolean;
}): Promise<string> {
  const c = opts.themed ? THEMED : DAY;
  const p = opts.payload;
  const qr = await QRCode.toDataURL(opts.verifyUrl, {
    margin: 1,
    width: 240,
    color: { dark: "#0E1726", light: "#FFFFFF" },
  });
  const diff = p.difficulty.charAt(0).toUpperCase() + p.difficulty.slice(1);
  const bands = p.bands ? `${p.bands.strong} / ${p.bands.partial} / ${p.bands.weak}` : "-";
  const hash = p.deliverable?.sha256 ? `sha256 ${p.deliverable.sha256.slice(0, 8)}…${p.deliverable.sha256.slice(-6)}` : "";
  const date = p.createdAt ? p.createdAt.slice(0, 10) : "";
  const verifyText = opts.verifyUrl.replace(/^https?:\/\//, "");
  const outcomeSize = p.outcome.length > 10 ? 30 : 38;
  const sample = p.demo?.sample === true;
  const approved = p.outcome === "Defended" && !sample;

  // Animation hooks: .pl-draw (stroke drawn in), .pl-fade, .pl-stamp, with
  // --len / --at / --d. Finished state is the default; the page adds .playing.
  // Stroke goes in an attribute too: PNG rendering drops a style attribute
  // that carries custom properties, while the themed page needs var() in style.
  const draw = (len: number, at: number, d = 0.4) =>
    `class="pl-draw" stroke="${DAY.ink}" style="--len:${len};--at:${at}s;--d:${d}s${opts.themed ? `;stroke:${c.ink}` : ""}"`;
  const fade = (at: number) => `class="pl-fade" style="--at:${at}s"`;
  const t = (x: number, y: number, size: number, fill: string, family: string, weight = 400, extra = "") =>
    `x="${x}" y="${y}" font-size="${size}" font-family="${family}" font-weight="${weight}" style="fill:${fill}" ${extra}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="560" height="300" viewBox="0 0 560 300" role="img" aria-label="${sample ? "Sample demo, not a credential" : "Defend It receipt"}: ${escapeHtml(p.outcome)}, ${p.score} of 100, ${escapeHtml(diff)}">
  <defs>
    <pattern id="pl-grid" width="14" height="14" patternUnits="userSpaceOnUse">
      <path d="M14 0H0V14" fill="none" style="stroke:${c.grid}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="560" height="300" style="fill:${c.sheet}"/>
  <rect width="560" height="300" fill="url(#pl-grid)"/>
  <rect x="10" y="10" width="540" height="280" fill="none" stroke-width="2" ${draw(1640, 0, 1)}/>
  <g ${fade(0.9)}><path d="M4 18V4H18M556 282V296H542" fill="none" stroke-width="2" stroke="${DAY.blue}" style="stroke:${c.blue}"/></g>
  <g ${fade(0.8)}><text ${t(30, 38, 10, c.blue, MONO, 400, 'letter-spacing="1.6"')}>${sample ? "DEFEND IT · SAMPLE DEMO" : "DEFEND IT · UNDERSTANDING RECEIPT"}</text></g>
  <g ${fade(1.05)}><text ${t(30, 84, outcomeSize, c.ink, DISPLAY, 700)}>${escapeHtml(p.outcome)}</text></g>
  <g ${fade(1.25)}><text ${t(30, 112, 11, c.ink2, MONO, 400)}>${escapeHtml(hash)}</text></g>
  <g ${fade(1.35)}><text ${t(30, 132, 11, c.ink2, MONO, 400)}>${escapeHtml(diff)} · ${escapeHtml(date)}</text></g>
  <g ${fade(1.2)}>
    <rect x="420" y="22" width="118" height="118" style="fill:#FFFFFF;stroke:${c.ink}" stroke-width="1.5"/>
    <image x="424" y="26" width="110" height="110" href="${qr}"/>
  </g>
  <line x1="10" y1="160" x2="550" y2="160" stroke-width="1.5" ${draw(540, 0.9, 0.5)}/>
  <line x1="145" y1="160" x2="145" y2="215" stroke-width="1" ${draw(55, 1.25, 0.25)}/>
  <line x1="280" y1="160" x2="280" y2="215" stroke-width="1" ${draw(55, 1.35, 0.25)}/>
  <line x1="415" y1="160" x2="415" y2="215" stroke-width="1" ${draw(55, 1.45, 0.25)}/>
  <line x1="10" y1="215" x2="550" y2="215" stroke-width="1" ${draw(540, 1.5, 0.45)}/>
  <g ${fade(1.85)}>
    <text ${t(22, 177, 8.5, c.ink2, MONO, 400, 'letter-spacing="1"')}>SCORE</text>
    <text ${t(22, 203, 18, c.ink, MONO, 700)}>${p.score}/100</text>
    <text ${t(157, 177, 8.5, c.ink2, MONO, 400, 'letter-spacing="1"')}>LEVEL</text>
    <text ${t(157, 203, 18, c.ink, MONO, 700)}>${escapeHtml(diff)}</text>
    <text ${t(292, 177, 8.5, c.ink2, MONO, 400, 'letter-spacing="1"')}>CLAIMS S / P / W</text>
    <text ${t(292, 203, 18, c.ink, MONO, 700)}>${bands}</text>
    <text ${t(427, 177, 8.5, c.ink2, MONO, 400, 'letter-spacing="1"')}>INTEGRITY</text>
    <text ${t(427, 203, 18, c.ink, MONO, 700)}>${escapeHtml(p.integrity?.status ?? "-")}</text>
    <text ${t(22, 233, 8.5, c.ink2, MONO, 400, 'letter-spacing="1"')}>CHECKED BY</text>
    <text ${t(22, 253, 12.5, c.ink, MONO, 400)}>Defend It council · ${escapeHtml(p.rubricVersion ?? "rubric")} · Ed25519</text>
    <text ${t(22, 276, 10, c.blue, MONO, 400, `textLength="${Math.min(510, verifyText.length * 6)}" lengthAdjust="spacingAndGlyphs"`)}>${escapeHtml(verifyText)}</text>
  </g>
  ${
    approved
      ? `<g class="pl-stamp" style="--at:2.25s"><g transform="rotate(-8 322 66)">
    <rect x="242" y="42" width="160" height="48" style="fill:${c.sheet};fill-opacity:.85;stroke:${c.signal}" stroke-width="3.5"/>
    <text ${t(322, 76, 22, c.signal, DISPLAY, 700, 'text-anchor="middle" letter-spacing="3.5"')}>${sample ? "SAMPLE" : "APPROVED"}</text>
  </g></g>`
      : sample
        ? `<g class="pl-stamp" style="--at:2.25s"><g transform="rotate(-8 322 66)">
    <rect x="242" y="42" width="160" height="48" style="fill:${c.sheet};fill-opacity:.85;stroke:${c.signal}" stroke-width="3.5"/>
    <text ${t(322, 76, 22, c.signal, DISPLAY, 700, 'text-anchor="middle" letter-spacing="3.5"')}>SAMPLE</text>
  </g></g>`
        : ""
  }
</svg>`;
}
