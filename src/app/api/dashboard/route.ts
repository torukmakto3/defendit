import { NextResponse } from "next/server";
import { walletView } from "@/lib/credits";
import { getDb } from "@/lib/db";
import { handleError, requireUser } from "@/lib/http";
import { billingEnabled } from "@/lib/plans";
import { listDashboard } from "@/lib/services";
import { checkoutCatalog } from "@/lib/stripe-config";
import { refillUserIfDue } from "@/lib/subscription-refill";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    await refillUserIfDue(guard.user.id);
    const db = await getDb();
    const [rows, wallet, profile] = await Promise.all([
      listDashboard(guard.user),
      walletView(guard.user.id),
      db.get<{ flag_reason: string | null; payment_notice: string | null }>(
        `SELECT flag_reason, payment_notice FROM billing_profiles WHERE user_id = ?`,
        [guard.user.id],
      ),
    ]);
    const products = checkoutCatalog() ?? [];
    return NextResponse.json({
      rows,
      wallet: {
        ...wallet,
        billingEnabled: billingEnabled(),
        products,
        billingFlag: profile?.flag_reason ?? null,
        paymentNotice: profile?.payment_notice ?? null,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
