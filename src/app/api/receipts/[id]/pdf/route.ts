import { jsonError } from "@/lib/http";
import { verifyReceipt } from "@/lib/receipt";
import { renderReceiptPdf } from "@/lib/receipt-pdf";
import { getReceipt } from "@/lib/services";

export const runtime = "nodejs";

/** One-page certificate to attach next to the deliverable. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const receipt = await getReceipt(id);
  if (!receipt) return jsonError(404, "Not found");
  const pdf = await renderReceiptPdf(receipt, verifyReceipt(receipt));
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="defend-it-receipt-${receipt.payload.id}.pdf"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
