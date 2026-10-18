import { getDb } from "./db";

/**
 * Fixed-window counter stored in the database, so limits hold across
 * serverless instances. One atomic upsert per check.
 */
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
  loginPerEmail: { limit: 5, windowSec: 15 * 60 },
  loginPerIp: { limit: 20, windowSec: 15 * 60 },
  ingestPerUser: { limit: 20, windowSec: 24 * 60 * 60 },
  sessionStartPerUser: { limit: 60, windowSec: 60 * 60 },
  learnTurnPerUser: { limit: 120, windowSec: 60 * 60 },
  defendAnswerPerUser: { limit: 300, windowSec: 60 * 60 },
  defendCompletePerUser: { limit: 20, windowSec: 24 * 60 * 60 },
  requestCreatePerUser: { limit: 50, windowSec: 24 * 60 * 60 },
} as const;
