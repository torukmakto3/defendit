import { NextResponse } from "next/server";
import { appUrl } from "@/lib/config";
import { verifyReceipt } from "@/lib/receipt";
import { getReceipt } from "@/lib/services";

export const runtime = "nodejs";

/** Printable cover sheet — attach or paste into email/Slack with the stamp. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const receipt = getReceipt(id);
  if (!receipt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const p = receipt.payload;
  const valid = verifyReceipt(receipt);
  const diff =
    p.difficulty.charAt(0).toUpperCase() + p.difficulty.slice(1);
  const stampUrl = appUrl(`/api/stamp/${p.id}`);
  const verifyUrl = receipt.verifyUrl;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Defend It — ${p.deliverable.fileName}</title>
  <style>
    body { font-family: Georgia, serif; color: #101810; margin: 40px; }
    .stamp { max-width: 420px; }
    .meta { font-family: ui-monospace, monospace; font-size: 12px; color: #3d5c45; }
    h1 { color: #1f4d2e; }
    .band { display: flex; justify-content: space-between; max-width: 420px; }
  </style>
</head>
<body>
  <h1>Defend It · Understanding cover</h1>
  <p>Attach this sheet (or the stamp image) to <strong>${p.deliverable.fileName}</strong> when you send it.</p>
  <p><img class="stamp" src="${stampUrl}" alt="Defend It stamp"/></p>
  <p><strong>${p.score}/100 · ${diff}</strong> · ${valid ? "signature valid" : "signature invalid"}</p>
  <p>Defended by ${p.creatorName} &lt;${p.creatorEmail}&gt;<br/>
  ${new Date(p.createdAt).toLocaleString()}</p>
  <p class="meta">sha256:${p.deliverable.sha256}</p>
  <p>Verify: <a href="${verifyUrl}">${verifyUrl}</a></p>
  <h2>Understanding by section</h2>
  ${(p.bandSummary || [])
    .map(
      (b) =>
        `<div class="band"><span>${b.section}</span><strong>${b.band}</strong></div>`,
    )
    .join("")}
  <h2>Integrity (separate)</h2>
  <p>${p.integrity.status}</p>
  <ul>${p.integrity.observations.map((o) => `<li>${o}</li>`).join("")}</ul>
  <p style="margin-top:48px;font-size:12px;color:#666">Rubric ${p.rubricVersion} · Models ${p.modelVersions.join(", ")}</p>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `inline; filename="defend-it-${p.id}-cover.html"`,
    },
  });
}
