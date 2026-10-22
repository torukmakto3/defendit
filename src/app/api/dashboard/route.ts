import { NextResponse } from "next/server";
import { walletView } from "@/lib/credits";
import { handleError, requireUser } from "@/lib/http";
import { billingEnabled } from "@/lib/payments";
import { listDashboard } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const [rows, wallet] = await Promise.all([
      listDashboard(guard.user),
      walletView(guard.user.id),
    ]);
    return NextResponse.json({ rows, wallet: { ...wallet, billingEnabled: billingEnabled() } });
  } catch (e) {
    return handleError(e);
  }
}
