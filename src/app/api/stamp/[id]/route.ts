import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const row = getDb()
    .prepare(`SELECT stamp_path FROM receipts WHERE id = ?`)
    .get(id) as { stamp_path: string | null } | undefined;

  const stampsDir = join(process.cwd(), "data", "stamps");
  const path = row?.stamp_path || join(stampsDir, `${id}.svg`);
  if (!path.startsWith(stampsDir) || !existsSync(/*turbopackIgnore: true*/ path)) {
    return NextResponse.json({ error: "Stamp not found" }, { status: 404 });
  }
  const svg = readFileSync(/*turbopackIgnore: true*/ path, "utf8");
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
