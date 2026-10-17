import { NextResponse } from "next/server";
import { listReceiverDashboard } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const email = new URL(req.url).searchParams.get("email");
  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }
  const rows = listReceiverDashboard(email);
  return NextResponse.json({
    items: rows.map((r) => {
      const receipt = r.payload_json
        ? (JSON.parse(r.payload_json) as {
            payload: { score: number; difficulty: string };
          })
        : null;
      return {
        id: r.id,
        token: r.token,
        title: r.title,
        difficulty: r.difficulty,
        status: r.status,
        createdAt: r.created_at,
        receiptId: r.receipt_id,
        score: receipt?.payload.score ?? null,
      };
    }),
  });
}
