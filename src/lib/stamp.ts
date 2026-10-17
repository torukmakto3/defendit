import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import QRCode from "qrcode";
import type { Difficulty } from "./types";

export async function generateStampSvg(opts: {
  receiptId: string;
  score: number;
  difficulty: Difficulty;
  verifyUrl: string;
}): Promise<{ svg: string; path: string }> {
  const qrDataUrl = await QRCode.toDataURL(opts.verifyUrl, {
    margin: 1,
    width: 120,
    color: { dark: "#0f1c14", light: "#00000000" },
  });

  const diffLabel =
    opts.difficulty.charAt(0).toUpperCase() + opts.difficulty.slice(1);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="420" height="120" viewBox="0 0 420 120">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e8f2ea"/>
      <stop offset="100%" stop-color="#d5e6d9"/>
    </linearGradient>
  </defs>
  <rect width="420" height="120" rx="10" fill="url(#bg)" stroke="#1f4d2e" stroke-width="2"/>
  <text x="20" y="36" font-family="Georgia, serif" font-size="18" fill="#1f4d2e" font-weight="700">Defend It</text>
  <text x="20" y="68" font-family="Georgia, serif" font-size="22" fill="#0f1c14">Defended ✓ ${opts.score}/100 · ${diffLabel}</text>
  <text x="20" y="96" font-family="ui-monospace, monospace" font-size="11" fill="#3d5c45">${opts.verifyUrl.replace(/^https?:\/\//, "")}</text>
  <image x="290" y="12" width="96" height="96" href="${qrDataUrl}"/>
</svg>`;

  const path = join(process.cwd(), "data", "stamps", `${opts.receiptId}.svg`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, svg, "utf8");
  return { svg, path };
}
