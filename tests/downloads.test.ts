import { describe, expect, it } from "vitest";
import { buildSignedReceipt } from "../src/lib/receipt";
import { renderReceiptPdf } from "../src/lib/receipt-pdf";
import { generateStampSvg, renderStampPng } from "../src/lib/stamp";

process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);

const receipt = buildSignedReceipt({
  difficulty: "hard",
  sha256: "e35ed1de5007c96b7b6e63df89ce73422fd4dab767a1705e5651171457ba71bc",
  byteLength: 1080,
  grades: [{ modelId: "m", provider: "p", overallScore: 91, claimGrades: [] }],
  integrity: { status: "Clear", observations: [], avgLatencyMs: 0, latencyVariance: 0, pasteEvents: 0, focusBlurEvents: 0 },
  displayName: "A Very Long Display Name That Should Not Break The Layout",
});

describe("receipt downloads", () => {
  it("renders a one-page PDF certificate", async () => {
    const pdf = Buffer.from(await renderReceiptPdf(receipt, true));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5_000);
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("renders the stamp as a PNG with embedded fonts", async () => {
    const svg = await generateStampSvg({ payload: receipt.payload, verifyUrl: receipt.verifyUrl });
    const png = await renderStampPng(svg);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(920); // width from fitTo
  });
});
