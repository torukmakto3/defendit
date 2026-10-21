import { NextResponse } from "next/server";
import { emailLinkOffered, googleAuthConfigured } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which sign-in methods the page should render. No secrets. */
export function GET() {
  return NextResponse.json(
    { google: googleAuthConfigured(), email: emailLinkOffered() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
