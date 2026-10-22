import { NextResponse } from "next/server";
import { readRequestCookie, type User } from "./auth";
import { betaDefenseCents, demoBudgetCanAfford } from "./credits";
import { sha256Hex } from "./crypto";
import { getDb } from "./db";
import {
  DEMO_COOKIE,
  DEMO_COPY,
  DEMO_WINDOW_SEC,
  demoDailyCap,
  demoEnabled,
  demoPerIpPerDay,
  demoRetentionHours,
  isDemoKind,
} from "./demo-policy";
import { jsonError, requireUser, sameOrigin } from "./http";
import { ipHash } from "./ip-hash";
import { rateLimit } from "./ratelimit";
import { getRequestByToken } from "./services";
import { isDeployed } from "./secrets";

/**
 * Keyed hash of the client address. Uses the shared helper: `IP_HASH_SALT`,
 * or `DEMO_IP_SALT` when that name is unset. Null when neither salt is usable.
 * The raw address is not stored, and a sample never starts on a null hash.
 */
export function hashDemoIp(ip: string): string | null {
  return ipHash(ip);
}

export function demoCookieOptions() {
  return {
    httpOnly: true,
    secure: isDeployed(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: demoRetentionHours() * 3600,
  };
}

export type DemoAdmission =
  | { ok: true }
  | { ok: false; status: number; message: string; retryAfterSec?: number };

/**
 * Kill switch, keyed hash, budget preview, then per-IP and global counters.
 * No usable salt is a 503: a sample does not run without a keyed hash, and it
 * does not skip the IP limit the way other routes do. The preview does not
 * consume a slot. The budget charge happens later, with the sample rows.
 * Expired demo counters are the only rate-limit rows this deletes.
 */
export async function admitDemo(ip: string): Promise<DemoAdmission> {
  if (!demoEnabled()) return { ok: false, status: 403, message: DEMO_COPY.disabled };
  const hashed = hashDemoIp(ip);
  if (!hashed) return { ok: false, status: 503, message: DEMO_COPY.unavailable };
  if (!(await demoBudgetCanAfford(betaDefenseCents()))) {
    return { ok: false, status: 503, message: DEMO_COPY.budget };
  }
  const db = await getDb();
  await db.run(
    `DELETE FROM rate_limits WHERE bucket_key LIKE 'demo:%' AND window_start < ?`,
    [new Date(Date.now() - DEMO_WINDOW_SEC * 1000).toISOString()],
  );
  const ipHit = await rateLimit(`demo:ip:${hashed}`, demoPerIpPerDay(), DEMO_WINDOW_SEC);
  if (!ipHit.ok) {
    return { ok: false, status: 429, message: DEMO_COPY.ip, retryAfterSec: ipHit.retryAfterSec };
  }
  const globalHit = await rateLimit("demo:day", demoDailyCap(), DEMO_WINDOW_SEC);
  if (!globalHit.ok) {
    return { ok: false, status: 429, message: DEMO_COPY.global, retryAfterSec: globalHit.retryAfterSec };
  }
  return { ok: true };
}

export async function demoUserForRequest(req: Request, requestId: string): Promise<User | null> {
  const token = readRequestCookie(req, DEMO_COOKIE);
  if (!token) return null;
  const db = await getDb();
  const row = await db.get<User>(
    `SELECT u.id, u.email, u.display_name
     FROM demo_passes p JOIN users u ON u.id = p.user_id
     WHERE p.token_hash = ? AND p.request_id = ? AND p.expires_at > ?`,
    [sha256Hex(token), requestId, new Date().toISOString()],
  );
  return row ?? null;
}

type Actor =
  | { user: User; demo: boolean; response?: undefined }
  | { response: NextResponse; user?: undefined; demo?: undefined };

/** A sample link is authorized by its demo cookie. Every other link needs a signed-in account. */
export async function resolveDefenseStart(req: Request, token: string): Promise<Actor> {
  if (req.method !== "GET" && !sameOrigin(req)) {
    return { response: jsonError(403, "Cross-site request blocked") };
  }
  const request = await getRequestByToken(token);
  if (request && isDemoKind(request.kind)) {
    if (!demoEnabled()) return { response: jsonError(403, DEMO_COPY.disabled) };
    const user = await demoUserForRequest(req, request.id);
    if (!user) return { response: jsonError(401, DEMO_COPY.openFromHome) };
    return { user, demo: true };
  }
  const guard = await requireUser(req);
  if (guard.response) return guard;
  return { user: guard.user, demo: false };
}

/** Answer, complete, and grading progress. A demo cookie cannot open someone else's session. */
export async function resolveDefenseSession(req: Request, sessionId: string): Promise<Actor> {
  if (req.method !== "GET" && !sameOrigin(req)) {
    return { response: jsonError(403, "Cross-site request blocked") };
  }
  const db = await getDb();
  const row = await db.get<{ user_id: string; kind: string; request_id: string }>(
    `SELECT s.user_id, r.kind, r.id AS request_id
     FROM sessions s JOIN defense_requests r ON r.id = s.request_id
     WHERE s.id = ?`,
    [sessionId],
  );
  if (row && isDemoKind(row.kind)) {
    if (!demoEnabled()) return { response: jsonError(403, DEMO_COPY.disabled) };
    const user = await demoUserForRequest(req, row.request_id);
    if (!user || user.id !== row.user_id) return { response: jsonError(404, "Defend session not found") };
    return { user, demo: true };
  }
  const guard = await requireUser(req);
  if (guard.response) return guard;
  return { user: guard.user, demo: false };
}
