import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { receiptGate, recordResultView } from "@/lib/challenges";
import { clientIp, jsonError } from "@/lib/http";
import { publicWriteBudget, rateLimit } from "@/lib/ratelimit";
import { verifyReceipt } from "@/lib/receipt";
import { getReceipt } from "@/lib/services";

export const runtime = "nodejs";

/**
 * A normal receipt is public: hash and score, no document content.
 * A challenge receipt follows the defender's visibility. Score-hidden and
 * private responses omit the signed payload so the number is not in the JSON.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getUserFromRequest(req);
  const gate = await receiptGate(id, user);
  if (gate.httpStatus === 404) return jsonError(404, "Not found");
  if (new URL(req.url).searchParams.get("view") === "1") {
    const budget = publicWriteBudget("result-view");
    const limited = await rateLimit(`result-view:${clientIp(req)}`, budget.limit, budget.windowSec);
    if (limited.ok) await recordResultView(id, user, clientIp(req));
  }
  if (gate.mode === "challenge" && !gate.includeReceipt) {
    return NextResponse.json({ receipt: null, signatureValid: null, challengeResult: gate.result });
  }
  const receipt = await getReceipt(id);
  if (!receipt) return jsonError(404, "Not found");
  return NextResponse.json({
    receipt,
    signatureValid: verifyReceipt(receipt),
    challengeResult: gate.result,
  });
}
