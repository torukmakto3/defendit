import { NextResponse } from "next/server";
import { z } from "zod";
import { admitDemo, demoCookieOptions } from "@/lib/demo";
import { DEMO_COOKIE, isDemoSampleId } from "@/lib/demo-policy";
import { handleError, jsonError, sameOrigin, clientIp } from "@/lib/http";
import { createDemoDefense } from "@/lib/services";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  sample: z.enum(["harbor-readme", "lane-memo"]).optional(),
});

/** Start a no-login defense on a bundled sample. Sets the demo cookie. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "Cross-site request blocked");
  try {
    const body = schema.parse(await req.json().catch(() => ({})));
    const sample = body.sample ?? "harbor-readme";
    if (!isDemoSampleId(sample)) return jsonError(400, "Unknown sample file.");
    const admission = await admitDemo(clientIp(req));
    if (!admission.ok) {
      const headers = admission.retryAfterSec ? { "Retry-After": String(admission.retryAfterSec) } : undefined;
      return jsonError(admission.status, admission.message, headers);
    }
    const created = await createDemoDefense(sample);
    const res = NextResponse.json({
      token: created.token,
      title: created.title,
      defendUrl: `/d/${created.token}/defend`,
      questions: created.questions,
      demo: true,
    });
    res.cookies.set(DEMO_COOKIE, created.passToken, demoCookieOptions());
    return res;
  } catch (e) {
    return handleError(e, "Could not start the sample demo");
  }
}
