import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError, jsonError, requireAdmin } from "@/lib/http";
import { getAdminSessionDetail, saveHumanGrade } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  try {
    const { id } = await ctx.params;
    const detail = await getAdminSessionDetail(id);
    if (!detail) return jsonError(404, "Not found");
    return NextResponse.json(detail);
  } catch (e) {
    return handleError(e);
  }
}

const gradeSchema = z.object({
  overallScore: z.number().min(0).max(100),
  notes: z.string().max(4000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  try {
    const { id } = await ctx.params;
    const body = gradeSchema.parse(await req.json());
    await saveHumanGrade({ sessionId: id, ...body, graderName: guard.user.email });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e, "Invalid");
  }
}
