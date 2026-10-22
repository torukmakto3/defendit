import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { readRequestCookie, type User } from "./auth";
import { betaBudgetCanAfford, betaDefenseCents } from "./credits";
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
import { rateLimit } from "./ratelimit";
import { getRequestByToken } from "./services";
import { isDeployed, load32ByteSecret } from "./secrets";

/**
 * Hash of the client address, keyed with a server-side salt. The raw address
 * is not stored. The rate-limit row that holds the hash is deleted when its
 * window ends.
 */
export function hashDemoIp(ip: string): string {
  const salt = load32ByteSecret("DEMO_IP_SALT", "demo-ip-salt.json");
  return createHmac("sha256", salt).update(ip).digest("hex");
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
 * Kill switch, budget preview, then per-IP and global counters. The preview
 * does not consume a slot. The counters use the shared rate limiter. The
 * budget charge happens later, in the same transaction as the sample rows.
 */
export async function admitDemo(ip: string): Promise<DemoAdmission> {
  if (!demoEnabled()) return { ok: false, status: 403, message: DEMO_COPY.disabled };
  if (!(await betaBudgetCanAfford(betaDefenseCents()))) {
    return { ok: false, status: 503, message: DEMO_COPY.budget };
  }
  const db = await getDb();
  await db.run(
    `DELETE FROM rate_limits WHERE bucket_key LIKE 'demo:ip:%' AND window_start < ?`,
    [new Date(Date.now() - DEMO_WINDOW_SEC * 1000).toISOString()],
  );
  const ipHit = await rateLimit(`demo:ip:${hashDemoIp(ip)}`, demoPerIpPerDay(), DEMO_WINDOW_SEC);
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
    const user = await demoUserForRequest(req, row.request_id);
    if (!user || user.id !== row.user_id) return { response: jsonError(404, "Defend session not found") };
    return { user, demo: true };
  }
  const guard = await requireUser(req);
  if (guard.response) return guard;
  return { user: guard.user, demo: false };
}
