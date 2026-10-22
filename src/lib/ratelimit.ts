import { sha256Hex } from "./crypto";
import { getDb } from "./db";

/**
 * Fixed-window counter stored in the database, so limits hold across
 * serverless instances and on both Postgres and SQLite. One atomic upsert per check.
 *
 * Counts and windows are env vars so a launch can tighten them without a deploy
 * of new code. Unset vars use the defaults below. A non-integer or a value below 1
 * throws, rather than silently disabling the limit.
 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function budget(limitName: string, limitDefault: number, windowName: string, windowDefault: number) {
  return {
    get limit() {
      return positiveInt(limitName, limitDefault);
    },
    get windowSec() {
      return positiveInt(windowName, windowDefault);
    },
  };
}

/**
 * Bucket key for an IP limit. The address is hashed so the rate-limit table
 * never stores the raw IP. Callers must pass the address only into this function.
 */
export function ipRateKey(scope: string, ip: string): string {
  return `${scope}:ip:${sha256Hex(ip)}`;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const db = await getDb();
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - windowSec * 1000).toISOString();
  const nowIso = now.toISOString();

  await db.run(
    `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (bucket_key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < ? THEN excluded.window_start ELSE rate_limits.window_start END`,
    [key, nowIso, windowStartCutoff, windowStartCutoff],
  );
  const row = await db.get<{ window_start: string; count: number }>(
    `SELECT window_start, count FROM rate_limits WHERE bucket_key = ?`,
    [key],
  );
  if (!row || Number(row.count) <= limit) return { ok: true, retryAfterSec: 0 };
  const resetAt = new Date(row.window_start).getTime() + windowSec * 1000;
  return {
    ok: false,
    retryAfterSec: Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000)),
  };
}

/** Named limits so routes share one table of budgets. */
export const LIMITS = {
  /** Magic-link sends, per hashed email. */
  loginPerEmail: budget("RATE_LIMIT_LOGIN_EMAIL", 5, "RATE_LIMIT_LOGIN_EMAIL_WINDOW_SEC", 15 * 60),
  /** Magic-link sends, Google sign-in, and link verification, per hashed IP. */
  loginPerIp: budget("RATE_LIMIT_LOGIN_IP", 20, "RATE_LIMIT_LOGIN_IP_WINDOW_SEC", 15 * 60),
  /** Uploads and Learn re-uploads, per account. */
  ingestPerUser: budget("RATE_LIMIT_UPLOAD_USER", 20, "RATE_LIMIT_UPLOAD_USER_WINDOW_SEC", 24 * 60 * 60),
  /** Uploads and Learn re-uploads, per hashed IP. */
  uploadPerIp: budget("RATE_LIMIT_UPLOAD_IP", 30, "RATE_LIMIT_UPLOAD_IP_WINDOW_SEC", 24 * 60 * 60),
  /** Learn or Defend session start, per account. */
  sessionStartPerUser: budget(
    "RATE_LIMIT_SESSION_START_USER",
    60,
    "RATE_LIMIT_SESSION_START_USER_WINDOW_SEC",
    60 * 60,
  ),
  /** Learn or Defend session start, per hashed IP. */
  sessionStartPerIp: budget(
    "RATE_LIMIT_SESSION_START_IP",
    30,
    "RATE_LIMIT_SESSION_START_IP_WINDOW_SEC",
    60 * 60,
  ),
  learnTurnPerUser: budget("RATE_LIMIT_LEARN_TURN_USER", 120, "RATE_LIMIT_LEARN_TURN_USER_WINDOW_SEC", 60 * 60),
  defendAnswerPerUser: budget(
    "RATE_LIMIT_DEFEND_ANSWER_USER",
    300,
    "RATE_LIMIT_DEFEND_ANSWER_USER_WINDOW_SEC",
    60 * 60,
  ),
  /** Paste and focus-loss updates during a defense, per account. */
  defendSignalsPerUser: budget(
    "RATE_LIMIT_DEFEND_SIGNALS_USER",
    600,
    "RATE_LIMIT_DEFEND_SIGNALS_USER_WINDOW_SEC",
    60 * 60,
  ),
  defendCompletePerUser: budget(
    "RATE_LIMIT_DEFEND_COMPLETE_USER",
    20,
    "RATE_LIMIT_DEFEND_COMPLETE_USER_WINDOW_SEC",
    24 * 60 * 60,
  ),
  requestCreatePerUser: budget(
    "RATE_LIMIT_REQUEST_CREATE_USER",
    50,
    "RATE_LIMIT_REQUEST_CREATE_USER_WINDOW_SEC",
    24 * 60 * 60,
  ),
  /** Challenge creates, per account. Same cap the challenge code used before. */
  challengeCreatePerUser: budget("CHALLENGE_CREATE_LIMIT", 10, "CHALLENGE_CREATE_WINDOW_SEC", 24 * 60 * 60),
  /** Challenge claims and declines, per account. */
  challengeClaimPerUser: budget("CHALLENGE_CLAIM_LIMIT", 20, "CHALLENGE_CLAIM_WINDOW_SEC", 24 * 60 * 60),
  /** Challenge claims and declines, per hashed IP. */
  challengeClaimPerIp: budget("CHALLENGE_CLAIM_IP_LIMIT", 30, "CHALLENGE_CLAIM_IP_WINDOW_SEC", 60 * 60),
  /** Public share-click events, per hashed IP. */
  challengeSharePerIp: budget("CHALLENGE_SHARE_LIMIT", 30, "CHALLENGE_SHARE_WINDOW_SEC", 60 * 60),
  /** Published-result view counts, per hashed IP. */
  challengeResultViewPerIp: budget(
    "CHALLENGE_RESULT_VIEW_LIMIT",
    60,
    "CHALLENGE_RESULT_VIEW_WINDOW_SEC",
    60 * 60,
  ),
  /** Challenge reports, per hashed IP. */
  challengeReportPerIp: budget("CHALLENGE_REPORT_LIMIT", 10, "CHALLENGE_REPORT_WINDOW_SEC", 60 * 60),
} as const;
