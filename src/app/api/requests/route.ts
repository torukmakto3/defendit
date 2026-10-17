import { NextResponse } from "next/server";
import { z } from "zod";
import { appUrl } from "@/lib/config";
import { createDefenseRequest } from "@/lib/services";

export const runtime = "nodejs";

const schema = z.object({
  receiverName: z.string().min(1),
  receiverEmail: z.string().email(),
  difficulty: z.enum(["standard", "hard", "expert"]),
  title: z.string().min(1),
  notes: z.string().optional(),
  pinnedClaims: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const created = createDefenseRequest(body);
    return NextResponse.json({
      ...created,
      shareUrl: appUrl(`/d/${created.token}`),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid request" },
      { status: 400 },
    );
  }
}
