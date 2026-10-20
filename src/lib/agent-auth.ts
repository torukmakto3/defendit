import { createHmac, timingSafeEqual } from "crypto";
import { HttpError } from "./errors";

/**
 * Requests from the voice interviewer agent are signed with a shared secret:
 * x-defend-timestamp + x-defend-signature = hex HMAC-SHA256(secret, "<ts>.<body>").
 * Five-minute window against replay. The secret never reaches a browser.
 */
const WINDOW_MS = 5 * 60_000;

export function agentSecret(): string {
  const s = process.env.VOICE_AGENT_SECRET;
  if (!s || s.length < 32) throw new HttpError(503, "Voice interviews are not configured.");
  return s;
}

export function signAgentBody(body: string, ts = Date.now(), secret = agentSecret()): { ts: string; signature: string } {
  return { ts: String(ts), signature: createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex") };
}

/** Returns the parsed JSON body when the signature is valid; throws 401 otherwise. */
export async function verifyAgentRequest<T>(req: Request): Promise<T> {
  const secret = agentSecret();
  const ts = Number(req.headers.get("x-defend-timestamp"));
  const sig = req.headers.get("x-defend-signature") || "";
  const body = await req.text();
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WINDOW_MS) throw new HttpError(401, "Stale request");
  const want = Buffer.from(signAgentBody(body, ts, secret).signature, "hex");
  const got = Buffer.from(sig, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "Bad signature");
  return JSON.parse(body) as T;
}
