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
  const mark = p.outcome === "Defended" ? "✓" : "";
  const verifyText = opts.verifyUrl.replace(/^https?:\/\//, "");

  // Text column ends at x=330; the QR sits to its right so long outcomes never overlap it.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="460" height="132" viewBox="0 0 460 132">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e8f2ea"/>
      <stop offset="100%" stop-color="#d5e6d9"/>
    </linearGradient>
  </defs>
  <rect width="460" height="132" rx="10" fill="url(#bg)" stroke="#1f4d2e" stroke-width="2"/>
  <text x="20" y="32" font-family="Georgia, serif" font-size="16" fill="#1f4d2e" font-weight="700">Defend It</text>
  <text x="20" y="60" font-family="Georgia, serif" font-size="20" fill="#0f1c14">${escapeHtml(p.outcome)} ${mark}</text>
  <text x="20" y="86" font-family="Georgia, serif" font-size="16" fill="#0f1c14">${p.score}/100 · ${escapeHtml(diffLabel)}</text>
  <text x="20" y="112" font-family="ui-monospace, monospace" font-size="9" fill="#3d5c45" textLength="${verifyText.length > 52 ? 310 : verifyText.length * 5.6}" lengthAdjust="spacingAndGlyphs">${escapeHtml(verifyText)}</text>
  <image x="344" y="14" width="104" height="104" href="${qrDataUrl}"/>
</svg>`;
}
