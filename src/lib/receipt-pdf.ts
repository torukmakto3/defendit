import fontkit from "@pdf-lib/fontkit";
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { appUrl } from "./config";
import { fontBytes } from "./fonts";
import { integritySummary } from "./integrity";
import type { ReceiptPayload, SignedReceipt } from "./types";

/**
 * One-page receipt certificate in the Titleblock style (DESIGN.md, day
 * palette): attach it next to the deliverable. Holds only what the signed
 * receipt holds, plus the signature and public key for offline checking.
 */
const C = {
  sheet: rgb(0.961, 0.969, 0.98),
  grid: rgb(0.867, 0.894, 0.933),
  ink: rgb(0.055, 0.09, 0.149),
  ink2: rgb(0.29, 0.333, 0.408),
  line: rgb(0.78, 0.816, 0.863),
  blue: rgb(0.122, 0.294, 0.847),
  signal: rgb(0.761, 0.255, 0.047),
  white: rgb(1, 1, 1),
};

/** Models on the certificate. A cheap over-cap grade is marked on that model. */
function gradedBy(p: Pick<ReceiptPayload, "graders" | "modelVersions">): string {
  if (!p.graders?.length) return p.modelVersions.join(", ");
  return p.graders.map((g) => (g.budgetFallback ? `${g.model} (budget fallback)` : g.model)).join(", ");
}

const W = 595.28; // A4 portrait, points
const H = 841.89;
const M = 48;

export async function renderReceiptPdf(receipt: SignedReceipt, signatureValid: boolean): Promise<Uint8Array> {
  const p = receipt.payload;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Defend It receipt ${p.id}`);
  doc.setSubject("Understanding receipt");
  doc.setProducer("Defend It");
  doc.setCreator("Defend It");

  const f = {
    display: await doc.embedFont(fontBytes("display"), { subset: true }),
    body: await doc.embedFont(fontBytes("body"), { subset: true }),
    bold: await doc.embedFont(fontBytes("bodyBold"), { subset: true }),
    // Built-in Courier for hashes, ids and URLs: renders literally (JetBrains
    // Mono's "://" ligatures crash @pdf-lib/fontkit 1.1.1) and needs no embedding.
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };
  const page = doc.addPage([W, H]);

  // Sheet, graph paper, frame and registration marks.
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C.sheet });
  for (let x = 0; x <= W; x += 18) page.drawLine({ start: { x, y: 0 }, end: { x, y: H }, thickness: 0.4, color: C.grid });
  for (let y = 0; y <= H; y += 18) page.drawLine({ start: { x: 0, y }, end: { x: W, y }, thickness: 0.4, color: C.grid });
  page.drawRectangle({ x: M - 16, y: M - 16, width: W - 2 * (M - 16), height: H - 2 * (M - 16), borderColor: C.ink, borderWidth: 1.5 });
  corner(page, M - 22, H - M + 22, 1, -1);
  corner(page, W - M + 22, M - 22, -1, 1);

  const sample = p.demo?.sample === true;
  let y = H - M - 10;
  text(page, sample ? "DEFEND IT  ·  SAMPLE DEMO" : "DEFEND IT  ·  UNDERSTANDING RECEIPT", M, y, f.mono, 9, C.blue, 1.4);
  y -= 40;
  text(page, p.outcome, M, y, f.display, 32, C.ink);
  if (sample) {
    const label = "SAMPLE";
    const size = 18;
    const tw = f.display.widthOfTextAtSize(label, size) + 4 * label.length * 0.9;
    const x0 = W - M - tw - 30;
    page.drawRectangle({ x: x0, y: y - 6, width: tw + 22, height: 34, borderColor: C.signal, borderWidth: 2.5, rotate: degrees(6) });
    text(page, label, x0 + 11, y + 4, f.display, size, C.signal, 3.2, 6);
  } else if (p.outcome === "Defended") {
    const label = "APPROVED";
    const size = 18;
    const tw = f.display.widthOfTextAtSize(label, size) + 4 * label.length * 0.9;
    const x0 = W - M - tw - 30;
    page.drawRectangle({ x: x0, y: y - 6, width: tw + 22, height: 34, borderColor: C.signal, borderWidth: 2.5, rotate: degrees(6) });
    text(page, label, x0 + 11, y + 4, f.display, size, C.signal, 3.2, 6);
  }
  y -= 22;
  text(
    page,
    `${signatureValid ? "Signature valid" : "SIGNATURE INVALID"}  ·  issued ${new Date(p.createdAt).toUTCString()}`,
    M,
    y,
    f.body,
    10,
    signatureValid ? C.ink2 : C.signal,
  );

  // Title block.
  y -= 28;
  const diff = p.difficulty.charAt(0).toUpperCase() + p.difficulty.slice(1);
  y = titleBlockRow(page, f, M, y, W - 2 * M, [
    ["SCORE", `${p.score}/100`],
    ["LEVEL", diff],
    ["DATE", p.createdAt.slice(0, 10)],
    ["STRONG / PARTIAL / WEAK", `${p.bands.strong} / ${p.bands.partial} / ${p.bands.weak}`],
  ]);
  y = titleBlockRow(page, f, M, y, W - 2 * M, [
    ["INTEGRITY (REPORTED SEPARATELY)", integritySummary(p.integrity)],
    ["ASSURANCE", p.assuranceLevel],
  ]);
  y = titleBlockRow(page, f, M, y, W - 2 * M, [
    ["DEFENDED BY", p.creator ? `${p.creator.displayName} (self-reported name, verified email sign-in)` : "Not disclosed by the creator"],
  ], 11);
  y = titleBlockRow(page, f, M, y, W - 2 * M, [["SHA-256 OF THE DEFENDED FILE", p.deliverable.sha256]], 9.5);
  y = titleBlockRow(page, f, M, y, W - 2 * M, [["RECEIPT", `${p.id}  ·  ${p.deliverable.byteLength.toLocaleString("en-US")} bytes`]]);

  // Verify: QR + steps.
  y -= 34;
  const verifyUrl = receipt.verifyUrl;
  const qr = await doc.embedPng(await QRCode.toBuffer(verifyUrl, { margin: 1, width: 360, color: { dark: "#0E1726", light: "#FFFFFF" } }));
  const qrSize = 132;
  page.drawRectangle({ x: M, y: y - qrSize - 6, width: qrSize + 12, height: qrSize + 12, color: C.white, borderColor: C.ink, borderWidth: 1.5 });
  page.drawImage(qr, { x: M + 6, y: y - qrSize, width: qrSize, height: qrSize });
  const sx = M + qrSize + 32;
  text(page, "HOW TO VERIFY", sx, y - 10, f.mono, 9, C.blue, 1.2);
  const steps = [
    "1. Scan the code or open the link below.",
    "2. Drop your copy of the deliverable on the page.",
    "3. Your browser hashes the file and checks the signature against",
    "    Defend It's published key. Nothing is uploaded.",
  ];
  steps.forEach((s, i) => text(page, s, sx, y - 30 - i * 16, f.body, 10.5, C.ink));
  wrapMono(page, verifyUrl, sx, y - 104, f.mono, 7.5, C.blue, W - M - sx);

  // Signature material for offline checks.
  y -= qrSize + 48;
  text(page, "ED25519 SIGNATURE", M, y, f.mono, 8, C.ink2, 1);
  y = wrapMono(page, receipt.signature, M, y - 13, f.mono, 7.5, C.ink, W - 2 * M);
  y -= 10;
  text(page, "PUBLIC KEY", M, y, f.mono, 8, C.ink2, 1);
  y = wrapMono(page, receipt.publicKey, M, y - 13, f.mono, 7.5, C.ink, W - 2 * M);
  text(page, `Published at ${appUrl("/.well-known/defend-it-pubkey.json")}`, M, y - 4, f.body, 8, C.ink2);

  // Footer.
  const foot = sample
    ? [
        "Demo on a sample file. Not a credential. It does not show that a person understands their own work.",
        `Sample: ${p.demo?.file ?? "bundled file"}. Removed after ${p.demo?.expiresAt?.slice(0, 10) ?? "one day"}.`,
        `Rubric ${p.rubricVersion}  ·  graded by ${gradedBy(p)}  ·  assurance ${p.assuranceLevel}`,
      ]
    : [
        "This receipt holds no document content, answers, file name or email. It certifies that the person who",
        "uploaded the file with this SHA-256 defended it in a timed interview graded against the rubric below.",
        `Rubric ${p.rubricVersion}  ·  graded by ${gradedBy(p)}  ·  assurance ${p.assuranceLevel}`,
      ];
  foot.forEach((s, i) => text(page, s, M, M + 22 - i * 12, f.body, 8, C.ink2));

  return doc.save();
}

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color = C.ink, spacing = 0, rotate = 0) {
  page.drawText(s, { x, y, font, size, color, characterSpacing: spacing, rotate: degrees(rotate) } as Parameters<PDFPage["drawText"]>[1]);
}

function corner(page: PDFPage, x: number, y: number, dx: 1 | -1, dy: 1 | -1) {
  page.drawLine({ start: { x, y }, end: { x: x + 12 * dx, y }, thickness: 1.5, color: C.blue });
  page.drawLine({ start: { x, y }, end: { x, y: y + 12 * dy }, thickness: 1.5, color: C.blue });
}

function wrapMono(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color: ReturnType<typeof rgb>, width: number): number {
  const per = Math.max(8, Math.floor(width / font.widthOfTextAtSize("0", size)));
  for (let i = 0; i < s.length; i += per) {
    text(page, s.slice(i, i + per), x, y, font, size, color);
    y -= size + 4;
  }
  return y;
}

function titleBlockRow(
  page: PDFPage,
  f: Record<"display" | "body" | "bold" | "mono" | "monoBold", PDFFont>,
  x: number,
  top: number,
  width: number,
  cells: [string, string][],
  valueSize = 12,
): number {
  const h = 42;
  const cw = width / cells.length;
  page.drawRectangle({ x, y: top - h, width, height: h, color: C.white, borderColor: C.ink, borderWidth: 1.2 });
  cells.forEach(([label, value], i) => {
    const cx = x + i * cw;
    if (i > 0) page.drawLine({ start: { x: cx, y: top }, end: { x: cx, y: top - h }, thickness: 0.8, color: C.line });
    text(page, label, cx + 8, top - 13, f.mono, 6.5, C.ink2, 0.8);
    let v = value;
    const max = cw - 16;
    while (v.length > 3 && f.monoBold.widthOfTextAtSize(v, valueSize) > max) v = `${v.slice(0, -2)}…`;
    text(page, v, cx + 8, top - 31, f.monoBold, valueSize, C.ink);
  });
  return top - h;
}
