import QRCode from "qrcode";
import { escapeHtml } from "./escape";
import type { ReceiptPayload } from "./types";


/** Rendered on demand from the signed payload; nothing is written to disk. */
export async function generateStampSvg(opts: {
  payload: Pick<ReceiptPayload, "score" | "difficulty" | "outcome">;
  verifyUrl: string;
}): Promise<string> {
  const qrDataUrl = await QRCode.toDataURL(opts.verifyUrl, {
    margin: 1,
    width: 120,
    color: { dark: "#0f1c14", light: "#00000000" },
  });
  const p = opts.payload;
  const diffLabel = p.difficulty.charAt(0).toUpperCase() + p.difficulty.slice(1);
  const verifyText = opts.verifyUrl.replace(/^https?:\/\//, "");

  // Titleblock stamp (DESIGN.md), always in the day palette: it travels in
  // emails and PDFs. Text column ends at x=330; the QR cell sits to its right.
  const approved = p.outcome === "Defended";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="460" height="140" viewBox="0 0 460 140">
  <defs>
    <pattern id="g" width="12" height="12" patternUnits="userSpaceOnUse">
      <path d="M12 0H0V12" fill="none" stroke="#DDE4EE" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="460" height="140" fill="#F5F7FA"/>
  <rect width="460" height="140" fill="url(#g)"/>
  <rect x="1" y="1" width="458" height="138" fill="none" stroke="#0E1726" stroke-width="2"/>
  <path d="M4 14V4H14M456 126V136H446" fill="none" stroke="#1F4BD8" stroke-width="2"/>
  <text x="18" y="28" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="10" letter-spacing="1.5" fill="#1F4BD8">DEFEND IT &#183; UNDERSTANDING RECEIPT</text>
  <text x="18" y="60" font-family="Sora, Helvetica, Arial, sans-serif" font-weight="700" font-size="22" fill="#0E1726">${escapeHtml(p.outcome)}</text>
  <rect x="18" y="72" width="312" height="30" fill="#FFFFFF" stroke="#0E1726" stroke-width="1.5"/>
  <line x1="122" y1="72" x2="122" y2="102" stroke="#0E1726" stroke-width="1"/>
  <line x1="226" y1="72" x2="226" y2="102" stroke="#0E1726" stroke-width="1"/>
  <text x="26" y="83" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="7" letter-spacing="1" fill="#4A5568">SCORE</text>
  <text x="26" y="97" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="12" font-weight="700" fill="#0E1726">${p.score}/100</text>
  <text x="130" y="83" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="7" letter-spacing="1" fill="#4A5568">LEVEL</text>
  <text x="130" y="97" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="12" font-weight="700" fill="#0E1726">${escapeHtml(diffLabel)}</text>
  <text x="234" y="83" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="7" letter-spacing="1" fill="#4A5568">VERIFY</text>
  <text x="234" y="97" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="12" font-weight="700" fill="#1F4BD8">scan QR</text>
  <text x="18" y="122" font-family="JetBrains Mono, ui-monospace, Menlo, monospace" font-size="9" fill="#4A5568" textLength="${verifyText.length > 52 ? 312 : verifyText.length * 5.6}" lengthAdjust="spacingAndGlyphs">${escapeHtml(verifyText)}</text>
  <rect x="342" y="14" width="106" height="106" fill="#FFFFFF" stroke="#0E1726" stroke-width="1.5"/>
  <image x="345" y="17" width="100" height="100" href="${qrDataUrl}"/>
  ${approved ? `<g transform="rotate(-6 268 52)"><rect x="214" y="39" width="108" height="27" fill="#F5F7FA" fill-opacity="0.85" stroke="#C2410C" stroke-width="2.5"/><text x="268" y="58" text-anchor="middle" font-family="Sora, Helvetica, Arial, sans-serif" font-weight="700" font-size="15" letter-spacing="2.5" fill="#C2410C">APPROVED</text></g>` : ""}
</svg>`;
}

/** PNG for pasting into email, Slack or Docs (2x for sharp text). */
export async function renderStampPng(svg: string): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const { fontPath } = await import("./fonts");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 920 },
    font: {
      loadSystemFonts: false,
      fontFiles: [fontPath("mono"), fontPath("monoBold"), fontPath("display"), fontPath("body")],
      defaultFontFamily: "Public Sans",
    },
  });
  return Buffer.from(resvg.render().asPng());
}
