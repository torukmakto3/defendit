import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminSessionDetail, saveHumanGrade } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const detail = getAdminSessionDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(detail);
}

const gradeSchema = z.object({
  overallScore: z.number().min(0).max(100),
  notes: z.string().optional(),
  graderName: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = gradeSchema.parse(await req.json());
    const humanId = saveHumanGrade({ sessionId: id, ...body });
    return NextResponse.json({ ok: true, humanId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid" },
      { status: 400 },
    );
  }
}
