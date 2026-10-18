import { NextResponse } from "next/server";
import { escapeHtml } from "@/lib/escape";
import { appUrl } from "@/lib/config";
import { jsonError } from "@/lib/http";
import { verifyReceipt } from "@/lib/receipt";
import { getReceipt } from "@/lib/services";

export const runtime = "nodejs";


/** Printable cover sheet — attach or paste into email/Slack with the stamp. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const receipt = await getReceipt(id);
  if (!receipt) return jsonError(404, "Not found");

  const p = receipt.payload;
  const valid = verifyReceipt(receipt);
  const diff = p.difficulty.charAt(0).toUpperCase() + p.difficulty.slice(1);
  const stampUrl = appUrl(`/api/stamp/${p.id}`);
  const verifyUrl = receipt.verifyUrl;
  const who = p.creator
    ? `Defended by ${escapeHtml(p.creator.displayName)} (self-reported name; verified email sign-in)`
    : "Defended";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Defend It — understanding cover</title>
  <style>
    body { font-family: Georgia, serif; color: #101810; margin: 40px; }
    .stamp { max-width: 420px; }
    .meta { font-family: ui-monospace, monospace; font-size: 12px; color: #3d5c45; word-break: break-all; }
    h1 { color: #1f4d2e; }
  </style>
</head>
<body>
  <h1>Defend It · Understanding cover</h1>
  <p>Attach this sheet (or the stamp image) to the deliverable when you send it.</p>
  <p><img class="stamp" src="${escapeHtml(stampUrl)}" alt="Defend It stamp"/></p>
  <p><strong>${escapeHtml(p.outcome)} · ${p.score}/100 · ${escapeHtml(diff)}</strong> · ${valid ? "signature valid" : "signature invalid"}</p>
  <p>${who}<br/>${escapeHtml(new Date(p.createdAt).toUTCString())}</p>
  <p>Claims probed: ${p.bands.strong} strong · ${p.bands.partial} partial · ${p.bands.weak} weak</p>
  <p>Integrity (reported separately): ${escapeHtml(p.integrity.status)}</p>
  <p class="meta">sha256:${escapeHtml(p.deliverable.sha256)}</p>
  <p>Verify: <a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
  <p style="margin-top:48px;font-size:12px;color:#666">Rubric ${escapeHtml(p.rubricVersion)} · Models ${escapeHtml(p.modelVersions.join(", "))}</p>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
