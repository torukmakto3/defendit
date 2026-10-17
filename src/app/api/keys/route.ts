import { NextResponse } from "next/server";
import { publicKeyInfo } from "@/lib/services";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(publicKeyInfo());
}
