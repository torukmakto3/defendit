import { createHash, timingSafeEqual } from "crypto";
import type { Db, Param } from "./db";
import { betaBudgetCents } from "./credits";

/**
 * Read-only aggregates for the daily traction dashboard.
 * Counts only: no account ids, emails, file names, or document text.
 *
 * Challenge totals are null when the challenge tables are not installed,
 * so this keeps working on a database from before those tables and starts
 * returning numbers once they exist.
 */

const DIFFICULTIES = ["standard", "hard", "expert"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

export interface TierPassRate {
  passed: number;
  completed: number;
  /** Passed ÷ completed. Null when nothing was completed. */
  rate: number | null;
}

export interface ChallengeStats {
  sent: number;
  accepted: number;
  declined: number;
}

export interface StatsSlice {
  signups: number;
  defenses_started: number;
  defenses_completed: number;
  pass_rate_by_tier: Record<Difficulty, TierPassRate>;
  receipts_issued: number;
  learn_opens: number;
  beta_budget: {
    spent_cents: number;
    total_cents: number;
    spent_eur: number;
    total_eur: number;
  };
  cost_per_completed_defense: {
    completed: number;
    llm_usd: number | null;
    voice_usd: number | null;
    with_measured_voice: number;
  };
  challenges: ChallengeStats | null;
}

export interface StatsReport {
  generated_at: string;
  range: {
    days: number | "all";
    /** Inclusive lower bound, UTC. Null when the range is all-time. */
    since: string | null;
  };
  window: StatsSlice;
  all_time: StatsSlice;
}

/** Blank and missing are both "not configured". */
export function statsToken(value = process.env.STATS_TOKEN): string | null {
  if (value == null || value.trim() === "") return null;
  return value;
}

/**
 * Compare a Bearer token to the configured secret. Both sides are hashed
 * first so the compare stays constant time when the lengths differ.
 */
export function statsBearerOk(authorization: string | null, secret: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  const presented = match?.[1] ?? "";
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(secret).digest();
  return timingSafeEqual(left, right);
}

/** `days` defaults to 1. `all` is the whole table. Anything else is rejected. */
export function parseStatsDays(raw: string | null): number | "all" | null {
  if (raw == null || raw.trim() === "") return 1;
  if (raw === "all") return "all";
  if (!/^[1-9]\d{0,3}$/.test(raw)) return null;
  const days = Number(raw);
  if (days > 3660) return null;
  return days;
}

export function statsSince(days: number | "all", now: Date): string | null {
  if (days === "all") return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function statsReport(
  db: Db,
  opts: { days: number | "all"; now?: Date },
): Promise<StatsReport> {
  const now = opts.now ?? new Date();
  const since = statsSince(opts.days, now);
  const [window, allTime] = await Promise.all([
    statsSlice(db, since),
    statsSlice(db, null),
  ]);
  return {
    generated_at: now.toISOString(),
    range: { days: opts.days, since },
    window,
    all_time: allTime,
  };
}

async function statsSlice(db: Db, since: string | null): Promise<StatsSlice> {
  const totalCents = betaBudgetCents();
  const [signups, started, completed, receipts, learnOpens, pass, cost, spentCents, challenges] =
    await Promise.all([
      count(db, "users", "created_at", since),
      count(db, "sessions", "started_at", since, "mode = 'defend'"),
      count(db, "sessions", "completed_at", since, "mode = 'defend' AND status = 'completed'"),
      count(db, "receipts", "created_at", since),
      count(db, "analytics_events", "occurred_at", since, "name = 'learn_opened'"),
      passRates(db, since),
      defenseCost(db, since),
      budgetSpentCents(db, since),
      challengeStats(db, since),
    ]);
  return {
    signups,
    defenses_started: started,
    defenses_completed: completed,
    pass_rate_by_tier: pass,
    receipts_issued: receipts,
    learn_opens: learnOpens,
    beta_budget: {
      spent_cents: spentCents,
      total_cents: totalCents,
      spent_eur: centsToEur(spentCents),
      total_eur: centsToEur(totalCents),
    },
    cost_per_completed_defense: cost,
    challenges,
  };
}

function centsToEur(cents: number): number {
  return Math.round(cents) / 100;
}

async function count(
  db: Db,
  table: string,
  column: string,
  since: string | null,
  extra?: string,
): Promise<number> {
  const filter = where(column, since, extra);
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COUNT(*) AS n FROM ${table}${filter.sql}`,
    filter.params,
  );
  return asNumber(row?.n);
}

async function passRates(db: Db, since: string | null): Promise<StatsSlice["pass_rate_by_tier"]> {
  const filter = where("r.created_at", since);
  const rows = await db.all<{ difficulty: string; payload_json: string }>(
    `SELECT dr.difficulty AS difficulty, r.payload_json AS payload_json
     FROM receipts r
     JOIN defense_requests dr ON dr.id = r.request_id${filter.sql}`,
    filter.params,
  );
  const tiers = emptyTiers();
  for (const row of rows) {
    if (!isDifficulty(row.difficulty)) continue;
    const bucket = tiers[row.difficulty];
    bucket.completed += 1;
    if (receiptPassed(row.payload_json)) bucket.passed += 1;
  }
  for (const tier of DIFFICULTIES) {
    const bucket = tiers[tier];
    bucket.rate = bucket.completed > 0 ? round4(bucket.passed / bucket.completed) : null;
  }
  return tiers;
}

/** A pass is the receipt outcome "Defended" (score 70 or higher). */
function receiptPassed(payloadJson: string): boolean {
  try {
    const parsed = JSON.parse(payloadJson) as { payload?: { outcome?: unknown } };
    return parsed.payload?.outcome === "Defended";
  } catch {
    return false;
  }
}

async function defenseCost(
  db: Db,
  since: string | null,
): Promise<StatsSlice["cost_per_completed_defense"]> {
  const filter = where("completed_at", since, "mode = 'defend' AND status = 'completed'");
  const row = await db.get<{
    n: number | string | null;
    llm: number | string | null;
    voice: number | string | null;
    voiced: number | string | null;
  }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(cost_usd), 0) AS llm,
            COALESCE(SUM(voice_cost_usd), 0) AS voice,
            COALESCE(SUM(CASE WHEN voice_cost_usd > 0 THEN 1 ELSE 0 END), 0) AS voiced
     FROM sessions${filter.sql}`,
    filter.params,
  );
  const completed = asNumber(row?.n);
  const llm = asNumber(row?.llm);
  const voice = asNumber(row?.voice);
  return {
    completed,
    llm_usd: completed > 0 ? round6(llm / completed) : null,
    voice_usd: completed > 0 ? round6(voice / completed) : null,
    with_measured_voice: asNumber(row?.voiced),
  };
}

/**
 * All-time spent is the `credit_budget` counter (id `beta`).
 * A shorter window sums `credit_ledger.budget_cents`, which is what moves
 * that counter, including refunds.
 */
async function budgetSpentCents(db: Db, since: string | null): Promise<number> {
  if (!since) {
    const row = await db.get<{ n: number | string | null }>(
      `SELECT spent_cents AS n FROM credit_budget WHERE id = 'beta'`,
    );
    return asNumber(row?.n);
  }
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COALESCE(SUM(budget_cents), 0) AS n FROM credit_ledger
     WHERE budget_cents IS NOT NULL AND created_at >= ?`,
    [since],
  );
  return asNumber(row?.n);
}

async function challengeStats(db: Db, since: string | null): Promise<ChallengeStats | null> {
  if (!(await challengesInstalled(db))) return null;
  try {
    const sent = await count(db, "challenges", "created_at", since);
    const accepted = await count(db, "challenges", "claimed_at", since, "claimed_at IS NOT NULL");
    const declined = await count(db, "challenges", "created_at", since, "status = 'declined'");
    return { sent, accepted, declined };
  } catch (e) {
    if (missingRelation(e)) return null;
    throw e;
  }
}

async function challengesInstalled(db: Db): Promise<boolean> {
  try {
    if (db.dialect === "postgres") {
      const row = await db.get<{ present: string | null }>(
        `SELECT to_regclass('public.challenges') AS present`,
      );
      return row?.present != null && String(row.present) !== "";
    }
    const row = await db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'challenges'`,
    );
    return row?.name === "challenges";
  } catch (e) {
    if (missingRelation(e)) return false;
    throw e;
  }
}

function missingRelation(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no such table|does not exist/i.test(message);
}

function where(column: string, since: string | null, extra?: string): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  if (extra) parts.push(extra);
  if (since) {
    parts.push(`${column} >= ?`);
    params.push(since);
  }
  if (parts.length === 0) return { sql: "", params };
  return { sql: ` WHERE ${parts.join(" AND ")}`, params };
}

function emptyTiers(): Record<Difficulty, TierPassRate> {
  return {
    standard: { passed: 0, completed: 0, rate: null },
    hard: { passed: 0, completed: 0, rate: null },
    expert: { passed: 0, completed: 0, rate: null },
  };
}

function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

function asNumber(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
