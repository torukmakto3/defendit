import { NextResponse } from "next/server";
import { walletView } from "@/lib/credits";
import { getDb } from "@/lib/db";
import { handleError, requireUser } from "@/lib/http";
import { billingEnabled } from "@/lib/plans";
import { listDashboard } from "@/lib/services";
import { checkoutCatalog, paymentsEnabled } from "@/lib/stripe-config";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const db = await getDb();
    const [rows, wallet, profile] = await Promise.all([
      listDashboard(guard.user),
      walletView(guard.user.id),
      db.get<{ flag_reason: string | null }>(`SELECT flag_reason FROM billing_profiles WHERE user_id = ?`, [
        guard.user.id,
      ]),
    ]);
    const products = checkoutCatalog() ?? [];
    return NextResponse.json({
      rows,
      wallet: {
        ...wallet,
        billingEnabled: billingEnabled(),
        paymentsEnabled: paymentsEnabled(),
        products,
        billingFlag: profile?.flag_reason ?? null,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
