import { createHash, timingSafeEqual } from "crypto";
import type { DemoDefenseStats } from "./analytics";
import type { Db, Param } from "./db";
import { betaBudgetCents } from "./credits";

/**
 * Throwaway sample accounts from the no-login demo. Matched by email even
 * when that branch has not added a `demo` request kind yet, and by request
 * kind or a receipt `payload.demo` when it has.
 */
const DEMO_EMAIL_LIKE = "%@demo.defendit.invalid";
const DEMO_PAYLOAD_LIKE = '%"demo":%';

/**
 * Read-only aggregates for the daily traction dashboard.
 * Counts only: no account ids, emails, file names, or document text.
 *
 * Challenge totals are null only when the challenges table is missing.
 * Sent, accepted, declined, defended, and expired are counts from that table.
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
  defended: number;
  expired: number;
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
  /** Sample defenses. Zeros when there are none. Not included in the counts above. */
  demo: DemoDefenseStats;
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
  const [signups, started, completed, receipts, learnOpens, pass, cost, spentCents, challenges, demo] =
    await Promise.all([
      countRealSignups(db, since),
      countRealDefenses(db, since, false),
      countRealDefenses(db, since, true),
      countRealReceipts(db, since),
      count(db, "analytics_events", "occurred_at", since, "name = 'learn_opened'"),
      passRates(db, since),
      defenseCost(db, since),
      budgetSpentCents(db, since),
      challengeStats(db, since),
      demoDefenseStats(db, since),
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
    demo,
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

/**
 * A session is a sample demo when its request kind is `demo`, its account
 * email ends in `@demo.defendit.invalid`, or its receipt carries `payload.demo`.
 * Any one of those is enough, so the filter holds before and after that branch.
 */
function demoSessionPredicate(): { sql: string; params: Param[] } {
  return {
    sql: `(r.kind = 'demo'
       OR LOWER(u.email) LIKE ?
       OR EXISTS (
         SELECT 1 FROM receipts rc_demo
         WHERE rc_demo.session_id = s.id AND rc_demo.payload_json LIKE ?
       ))`,
    params: [DEMO_EMAIL_LIKE, DEMO_PAYLOAD_LIKE],
  };
}

async function countRealSignups(db: Db, since: string | null): Promise<number> {
  const params: Param[] = [DEMO_EMAIL_LIKE];
  const time = since ? " AND created_at >= ?" : "";
  if (since) params.push(since);
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COUNT(*) AS n FROM users WHERE LOWER(email) NOT LIKE ?${time}`,
    params,
  );
  return asNumber(row?.n);
}

async function countRealDefenses(db: Db, since: string | null, completed: boolean): Promise<number> {
  const demo = demoSessionPredicate();
  const column = completed ? "s.completed_at" : "s.started_at";
  const params = [...demo.params];
  const parts = [
    "s.mode = 'defend'",
    `NOT ${demo.sql}`,
    completed ? "s.status = 'completed'" : "",
  ].filter((part) => part.length > 0);
  if (since) {
    parts.push(`${column} >= ?`);
    params.push(since);
  }
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COUNT(*) AS n
     FROM sessions s
     JOIN defense_requests r ON r.id = s.request_id
     JOIN users u ON u.id = s.user_id
     WHERE ${parts.join(" AND ")}`,
    params,
  );
  return asNumber(row?.n);
}

async function countRealReceipts(db: Db, since: string | null): Promise<number> {
  const params: Param[] = [DEMO_EMAIL_LIKE, DEMO_EMAIL_LIKE, DEMO_PAYLOAD_LIKE];
  const time = since ? " AND rc.created_at >= ?" : "";
  if (since) params.push(since);
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COUNT(*) AS n
     FROM receipts rc
     JOIN defense_requests r ON r.id = rc.request_id
     JOIN users owner ON owner.id = r.owner_user_id
     LEFT JOIN sessions s ON s.id = rc.session_id
     LEFT JOIN users actor ON actor.id = s.user_id
     WHERE r.kind <> 'demo'
       AND LOWER(owner.email) NOT LIKE ?
       AND (actor.email IS NULL OR LOWER(actor.email) NOT LIKE ?)
       AND rc.payload_json NOT LIKE ?${time}`,
    params,
  );
  return asNumber(row?.n);
}

/** Sample defenses in the window. Each field is 0 when there are none. */
export async function demoDefenseStats(db: Db, since: string | null): Promise<DemoDefenseStats> {
  const demo = demoSessionPredicate();
  const params: Param[] = [];
  const started = since ? " AND s.started_at >= ?" : "";
  const completed = since ? " AND s.completed_at >= ?" : "";
  if (since) params.push(since, since);
  params.push(...demo.params);
  const row = await db.get<{ started: number | string | null; completed: number | string | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN s.mode = 'defend'${started} THEN 1 ELSE 0 END), 0) AS started,
       COALESCE(SUM(CASE WHEN s.mode = 'defend' AND s.status = 'completed'${completed} THEN 1 ELSE 0 END), 0) AS completed
     FROM sessions s
     JOIN defense_requests r ON r.id = s.request_id
     JOIN users u ON u.id = s.user_id
     WHERE ${demo.sql}`,
    params,
  );
  return {
    started: asNumber(row?.started),
    completed: asNumber(row?.completed),
    budget_cents: await demoBudgetCents(db, since),
  };
}

async function demoBudgetCents(db: Db, since: string | null): Promise<number> {
  const params: Param[] = [];
  const time = since ? " AND created_at >= ?" : "";
  if (since) params.push(since);
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COALESCE(SUM(budget_cents), 0) AS n FROM credit_ledger
     WHERE (purpose = 'demo' OR ref_type = 'demo' OR idempotency_key LIKE 'demo-budget:%')${time}`,
    params,
  );
  return asNumber(row?.n);
}

async function passRates(db: Db, since: string | null): Promise<StatsSlice["pass_rate_by_tier"]> {
  const params: Param[] = [DEMO_EMAIL_LIKE, DEMO_EMAIL_LIKE, DEMO_PAYLOAD_LIKE];
  const time = since ? " AND rc.created_at >= ?" : "";
  if (since) params.push(since);
  const rows = await db.all<{ difficulty: string; payload_json: string }>(
    `SELECT r.difficulty AS difficulty, rc.payload_json AS payload_json
     FROM receipts rc
     JOIN defense_requests r ON r.id = rc.request_id
     JOIN users owner ON owner.id = r.owner_user_id
     LEFT JOIN sessions s ON s.id = rc.session_id
     LEFT JOIN users actor ON actor.id = s.user_id
     WHERE r.kind <> 'demo'
       AND LOWER(owner.email) NOT LIKE ?
       AND (actor.email IS NULL OR LOWER(actor.email) NOT LIKE ?)
       AND rc.payload_json NOT LIKE ?${time}`,
    params,
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
  const demo = demoSessionPredicate();
  const params: Param[] = [...demo.params];
  const time = since ? " AND s.completed_at >= ?" : "";
  if (since) params.push(since);
  const row = await db.get<{
    n: number | string | null;
    llm: number | string | null;
    voice: number | string | null;
    voiced: number | string | null;
  }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(s.cost_usd), 0) AS llm,
            COALESCE(SUM(s.voice_cost_usd), 0) AS voice,
            COALESCE(SUM(CASE WHEN s.voice_cost_usd > 0 THEN 1 ELSE 0 END), 0) AS voiced
     FROM sessions s
     JOIN defense_requests r ON r.id = s.request_id
     JOIN users u ON u.id = s.user_id
     WHERE s.mode = 'defend' AND s.status = 'completed' AND NOT ${demo.sql}${time}`,
    params,
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
    const defended = await count(db, "challenges", "created_at", since, "status = 'defended'");
    const expired = await count(db, "challenges", "created_at", since, "status = 'expired'");
    return { sent, accepted, declined, defended, expired };
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
