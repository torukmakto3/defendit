import { AsyncLocalStorage } from "async_hooks";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import type BetterSqlite3 from "better-sqlite3";
import type { Sql } from "postgres";

/**
 * One async data-access seam for two backends:
 * - Postgres when DATABASE_URL is set (Vercel / production)
 * - SQLite file otherwise (local dev, tests, smoke)
 *
 * SQL is written once with `?` placeholders; the Postgres adapter rewrites
 * them to `$n`. Keep queries to the shared dialect (no SQLite-only functions).
 */
export type Param = string | number | null;

export interface Db {
  readonly dialect: "sqlite" | "postgres";
  all<T>(sql: string, params?: Param[]): Promise<T[]>;
  get<T>(sql: string, params?: Param[]): Promise<T | undefined>;
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  next_path TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS defense_requests (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  creator_user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  pinned_claims TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES defense_requests(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  claim_count INTEGER NOT NULL,
  file_name_enc TEXT,
  text_enc TEXT,
  claims_enc TEXT,
  text_purge_after TEXT,
  purge_after TEXT NOT NULL,
  purged_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES defense_requests(id),
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL,
  seed TEXT NOT NULL,
  plan_enc TEXT,
  transcript_enc TEXT,
  gap_map_enc TEXT,
  integrity_json TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  purge_after TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'text'
);

CREATE TABLE IF NOT EXISTS grades (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  scores_enc TEXT,
  overall_score DOUBLE PRECISION NOT NULL,
  temperature REAL,
  seed INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_grades (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  overall_score DOUBLE PRECISION NOT NULL,
  notes TEXT,
  grader_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  request_id TEXT NOT NULL REFERENCES defense_requests(id),
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL REFERENCES defense_requests(id),
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  claim_id TEXT,
  front_enc TEXT NOT NULL,
  back_enc TEXT NOT NULL,
  source_enc TEXT,
  card_json TEXT NOT NULL,
  due TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purge_after TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL
);

-- One row per model call. No foreign keys: a call can be recorded before its
-- session row is inserted (question wording runs first). Totals live on sessions.
CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  request_id TEXT,
  purpose TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd DOUBLE PRECISION NOT NULL,
  cost_source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_owner ON defense_requests(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_requests_creator ON defense_requests(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_request ON deliverables(request_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_purge ON deliverables(purge_after);
CREATE INDEX IF NOT EXISTS idx_sessions_purge ON sessions(purge_after);
CREATE INDEX IF NOT EXISTS idx_flashcards_user_due ON flashcards(user_id, due);
CREATE INDEX IF NOT EXISTS idx_flashcards_deliverable ON flashcards(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_request ON llm_calls(request_id);
-- One receipt per deliverable request, enforced by the database too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_request ON receipts(request_id);

-- Per-stage latency for one defense. Upload rows exist before the session does,
-- so request_id is set and session_id is null until a session is known.
CREATE TABLE IF NOT EXISTS stage_timings (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  session_id TEXT,
  stage TEXT NOT NULL,
  detail TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_timings_session ON stage_timings(session_id);
CREATE INDEX IF NOT EXISTS idx_stage_timings_request ON stage_timings(request_id);

-- One row per in-flight model call. The cap sums rows newer than the hold
-- window, so a killed request stops blocking the defense after that window.
CREATE TABLE IF NOT EXISTS budget_holds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  usd DOUBLE PRECISION NOT NULL,
  grades INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_holds_session ON budget_holds(session_id, created_at);

-- Append-only credit wallet. Balance for a kind is the sum of its amounts.
-- learn_slot is a capacity (active projects), not a credit that is spent.
-- flex is a pack credit that can pay for a defense or a challenge.
CREATE TABLE IF NOT EXISTS credit_wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  lock_nonce INTEGER NOT NULL DEFAULT 0,
  -- Open Learn projects claimed while billing is on. The slot check is one
  -- conditional UPDATE of this counter, under the wallet row lock.
  learn_open INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Budget counters. spent_cents moves only by a conditional UPDATE so two
-- accounts cannot both pass a stale read. id beta is BETA_BUDGET_EUR.
-- id demo is the sample lifetime cap (DEMO_BUDGET_EUR) and is never
-- mixed into the beta row.
CREATE TABLE IF NOT EXISTS credit_budget (
  id TEXT PRIMARY KEY,
  spent_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  source TEXT,
  purpose TEXT,
  ref_type TEXT,
  ref_id TEXT,
  sponsored INTEGER NOT NULL DEFAULT 0,
  budget_cents INTEGER,
  period_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_ref ON credit_ledger(ref_type, ref_id);

-- One beta grant per account. The primary key is the unique constraint.
CREATE TABLE IF NOT EXISTS beta_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  granted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_plans (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  plan_id TEXT NOT NULL,
  interval TEXT,
  status TEXT NOT NULL,
  period_id TEXT,
  current_period_end TEXT,
  stripe_subscription_id TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  current_period_start TEXT,
  grant_anchor TEXT,
  last_granted_period_index INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  card_fingerprint TEXT,
  stripe_customer_id TEXT,
  flagged_at TEXT,
  flag_reason TEXT,
  payment_notice TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS defense_holds (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  hold_idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- A defense the user was challenged into. Sharing is not stored: the onward
-- credit does not depend on it.
CREATE TABLE IF NOT EXISTS credit_challenge_claims (
  challenge_id TEXT PRIMARY KEY,
  challenger_user_id TEXT NOT NULL REFERENCES users(id),
  defender_user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT UNIQUE,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_overages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  ref_type TEXT,
  ref_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A challenge wraps one sponsored defense. The document stays on the defense rows.
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  target_hint TEXT,
  subject TEXT NOT NULL,
  source_url TEXT,
  note TEXT,
  difficulty TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  sponsor_type TEXT NOT NULL DEFAULT 'beta',
  claimed_by_user_id TEXT REFERENCES users(id),
  claimed_at TEXT,
  expires_at TEXT NOT NULL,
  finish_by TEXT,
  request_id TEXT REFERENCES defense_requests(id),
  deliverable_id TEXT,
  session_id TEXT,
  receipt_id TEXT,
  visibility TEXT,
  adult_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS challenge_events (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  event TEXT NOT NULL,
  user_id TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);

-- A user who opts out cannot claim, and their email and handles cannot be targeted.
CREATE TABLE IF NOT EXISTS challenge_opt_outs (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_opt_out_keys (
  user_id TEXT NOT NULL REFERENCES users(id),
  key_value TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- A signed-in person who is not the named target can hide one open challenge
-- for themselves. The challenge stays open for everyone else.
CREATE TABLE IF NOT EXISTS challenge_hides (
  challenge_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (challenge_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_challenges_creator ON challenges(creator_user_id, status);
CREATE INDEX IF NOT EXISTS idx_challenges_claimed ON challenges(claimed_by_user_id, status);
-- One claimed (unfinished) challenge per defender. A count-then-update races
-- under Postgres read committed; the partial unique index does not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenges_one_claimed_defender
  ON challenges (claimed_by_user_id) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS idx_challenges_request ON challenges(request_id);
CREATE INDEX IF NOT EXISTS idx_challenges_receipt ON challenges(receipt_id);
CREATE INDEX IF NOT EXISTS idx_challenges_created ON challenges(created_at);
CREATE INDEX IF NOT EXISTS idx_challenge_events_challenge ON challenge_events(challenge_id, event);

-- First-party funnel counts. No account id, session id, receipt id, IP,
-- user agent, cookie, or document content. occurred_at is UTC, to the minute.
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  referrer_domain TEXT,
  props_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time ON analytics_events(name, occurred_at);
-- Columns the daily stats query filters on. Session indexes are created after
-- column migrations: an older sessions table may not have those columns yet.
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_created ON credit_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_challenges_claimed_at ON challenges(claimed_at);

-- Anonymous sample defense. The cookie is stored only as a hash.
-- request_id is unique so a sample link has one pass. session_id is claimed
-- by the first defend start so a refresh cannot open a second paid interview.
CREATE TABLE IF NOT EXISTS demo_passes (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES defense_requests(id),
  session_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Credits granted for one Stripe event, one row per kind. A refund claws
-- back from these rows and never from the beta grant.
CREATE TABLE IF NOT EXISTS stripe_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  credits INTEGER NOT NULL,
  checkout_session_id TEXT,
  invoice_id TEXT,
  payment_intent_id TEXT,
  charge_id TEXT,
  refunded_at TEXT,
  clawed_credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_grants_event ON stripe_grants(event_id);
CREATE INDEX IF NOT EXISTS idx_stripe_grants_payment_intent ON stripe_grants(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_grants_charge ON stripe_grants(charge_id);
CREATE INDEX IF NOT EXISTS idx_stripe_grants_invoice ON stripe_grants(invoice_id);

-- Last Stripe event time for a subscription. terminal = 1 after delete or cancel,
-- and a later invoice or checkout must not set the plan active again.
-- refills_stopped = 1 after a full refund or a dispute. It does not cancel
-- the subscription. A later paid invoice clears it and grants.
CREATE TABLE IF NOT EXISTS stripe_subscription_state (
  subscription_id TEXT PRIMARY KEY,
  last_event_created INTEGER NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0,
  refills_stopped INTEGER NOT NULL DEFAULT 0
);

-- One-time top-up from the earlier beta grant. The primary key is the idempotency gate.
CREATE TABLE IF NOT EXISTS beta_allowance_topups (
  user_id TEXT NOT NULL REFERENCES users(id),
  topup_key TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (user_id, topup_key)
);

-- One rating per defender per completed defense. Comments are not on the public receipt.
CREATE TABLE IF NOT EXISTS defense_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_defense_feedback_created ON defense_feedback(created_at);

-- Emails waiting for founding checkout. No account is required. The address is the key.
CREATE TABLE IF NOT EXISTS founding_waitlist (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Row lock for the 100-spot count. Incrementing lock_nonce holds the row until commit.
CREATE TABLE IF NOT EXISTS founding_inventory (
  id TEXT PRIMARY KEY,
  lock_nonce INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS founding_spots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  checkout_session_id TEXT,
  payment_intent_id TEXT,
  reserved_at TEXT NOT NULL,
  expires_at TEXT,
  confirmed_at TEXT,
  released_at TEXT
);

-- One open spot per account. Released rows stay so a refund can free the cap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_founding_spots_one_open
  ON founding_spots (user_id) WHERE status IN ('reserved', 'confirmed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_founding_spots_session
  ON founding_spots (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
`;

/** Stats filters on these session columns. Skip when an older table lacks them. */
const SESSION_STATS_INDEXES = [
  ["idx_sessions_started", "started_at"],
  ["idx_sessions_completed", "completed_at"],
] as const;

/** Columns added after a table first shipped: [table, column, definition]. */
const ADDED_COLUMNS: [string, string, string][] = [
  ["sessions", "channel", "TEXT NOT NULL DEFAULT 'text'"],
  ["sessions", "grading_claimed_at", "TEXT"],
  ["grades", "temperature", "REAL"],
  ["grades", "seed", "INTEGER"],
  // Running total of model calls for this session. A defend session rolls up
  // every call on its defense (claims, Learn, flashcards, questions, graders).
  ["sessions", "prompt_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "completion_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "cost_usd", "DOUBLE PRECISION NOT NULL DEFAULT 0"],
  ["sessions", "over_budget", "INTEGER NOT NULL DEFAULT 0"],
  // Cap applied to this defense. NULL on rows created before per-plan caps.
  ["sessions", "cost_tier", "TEXT"],
  ["sessions", "budget_usd", "DOUBLE PRECISION"],
  // 1 when a call was skipped or moved to the cheap model so the cap would hold.
  ["sessions", "budget_capped", "INTEGER NOT NULL DEFAULT 0"],
  // Live total of budget_holds newer than the hold window. The gate reads the
  // rows, then refreshes these columns. A killed request ages out of both.
  ["sessions", "reserved_usd", "DOUBLE PRECISION NOT NULL DEFAULT 0"],
  ["sessions", "reserved_grades", "INTEGER NOT NULL DEFAULT 0"],
  // LiveKit interviewer usage, reported by the agent. Dollars are seconds × env rates.
  ["sessions", "voice_agent_sec", "DOUBLE PRECISION NOT NULL DEFAULT 0"],
  ["sessions", "voice_stt_sec", "DOUBLE PRECISION NOT NULL DEFAULT 0"],
  ["sessions", "voice_tts_sec", "DOUBLE PRECISION NOT NULL DEFAULT 0"],
  ["sessions", "voice_cost_usd", "DOUBLE PRECISION NOT NULL DEFAULT 0"],
  ["flashcards", "source_enc", "TEXT"],
  // Live grading progress for the interview UI: {done, total, stage}.
  ["sessions", "grading_progress", "TEXT"],
  // Phrased first question, encrypted, computed while the upload is saved.
  ["defense_requests", "question_prefetch_enc", "TEXT"],
  // NULL: a deck saved before this column. 0: a deck is still being written. 1: the deck is complete.
  ["deliverables", "study_deck_ready", "INTEGER"],
  // 1 when the defense credit was a beta (sponsored) credit.
  ["sessions", "sponsored", "INTEGER NOT NULL DEFAULT 0"],
  // Set when the creator closes the Learn project. The slot is free again.
  // Retention of the file is unchanged.
  ["defense_requests", "learn_closed_at", "TEXT"],
  ["credit_wallets", "learn_open", "INTEGER NOT NULL DEFAULT 0"],
  // Set when a card refund could not take back credits that were already spent.
  ["billing_profiles", "flagged_at", "TEXT"],
  ["billing_profiles", "flag_reason", "TEXT"],
  ["billing_profiles", "stripe_customer_id", "TEXT"],
  ["billing_profiles", "payment_notice", "TEXT"],
  ["user_plans", "stripe_subscription_id", "TEXT"],
  ["user_plans", "cancel_at_period_end", "INTEGER NOT NULL DEFAULT 0"],
  ["user_plans", "current_period_start", "TEXT"],
  ["user_plans", "grant_anchor", "TEXT"],
  ["user_plans", "last_granted_period_index", "INTEGER"],
  // Monotonic integrity totals. A reload restores these; a later report cannot lower them.
  ["sessions", "paste_events", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "focus_blur_events", "INTEGER NOT NULL DEFAULT 0"],
  // Set on a sample-demo receipt. Null on a normal receipt, which is kept.
  ["receipts", "purge_after", "TEXT"],
  ["stripe_grants", "clawed_credits", "INTEGER NOT NULL DEFAULT 0"],
  ["stripe_subscription_state", "refills_stopped", "INTEGER NOT NULL DEFAULT 0"],
];

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (process.env.DATABASE_URL ? openPostgres() : openSqlite()).catch(
      (e) => {
        dbPromise = null;
        throw e;
      },
    );
  }
  return dbPromise;
}

async function openSqlite(): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");
  // v2 schema lives in a new file so an old prototype DB is never misread.
  const path =
    process.env.DATABASE_PATH || join(/*turbopackIgnore: true*/ process.cwd(), "data", "defend-it-v2.db");
  mkdirSync(/*turbopackIgnore: true*/ dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  // Wait for the writer instead of failing the budget or slot UPDATE.
  raw.pragma("busy_timeout = 5000");
  raw.exec(SCHEMA.replaceAll("DOUBLE PRECISION", "REAL"));
  for (const [table, column, def] of ADDED_COLUMNS) {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  const sessionCols = raw.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  for (const [index, column] of SESSION_STATS_INDEXES) {
    if (!sessionCols.some((col) => col.name === column)) continue;
    raw.exec(`CREATE INDEX IF NOT EXISTS ${index} ON sessions(${column})`);
  }
  return sqliteAdapter(raw);
}

function sqliteAdapter(raw: BetterSqlite3.Database): Db {
  const open = new AsyncLocalStorage<true>();
  let tail: Promise<void> = Promise.resolve();
  const db: Db = {
    dialect: "sqlite",
    async all<T>(sql: string, params: Param[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: Param[] = []) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    async run(sql: string, params: Param[] = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: r.changes };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      // One connection. A call already inside this transaction joins it.
      // A second top-level call waits until the open one commits.
      if (open.getStore()) return fn(db);
      const run = tail.then(() =>
        open.run(true, async () => {
          raw.exec("BEGIN IMMEDIATE");
          try {
            const out = await fn(db);
            raw.exec("COMMIT");
            return out;
          } catch (e) {
            raw.exec("ROLLBACK");
            throw e;
          }
        }),
      );
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return db;
}

async function openPostgres(): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, {
    max: Number(process.env.DATABASE_POOL_MAX || "5"),
    idle_timeout: 20,
    // Pooled serverless endpoints (Neon/PgBouncer) don't support prepared statements.
    prepare: false,
    onnotice: () => {},
  });
  // Concurrent cold starts would otherwise race on CREATE TABLE IF NOT EXISTS.
  await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(726213)");
    await tx.unsafe(SCHEMA);
    for (const [table, column, def] of ADDED_COLUMNS) {
      await tx.unsafe(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
    }
    for (const [index, column] of SESSION_STATS_INDEXES) {
      await tx.unsafe(`CREATE INDEX IF NOT EXISTS ${index} ON sessions(${column})`);
    }
  });
  return postgresAdapter(sql);
}

export function toPgPlaceholders(query: string): string {
  let n = 0;
  return query.replace(/\?/g, () => `$${++n}`);
}

function postgresAdapter(sql: Sql): Db {
  const db: Db = {
    dialect: "postgres",
    async all<T>(query: string, params: Param[] = []) {
      return (await sql.unsafe(toPgPlaceholders(query), params)) as unknown as T[];
    },
    async get<T>(query: string, params: Param[] = []) {
      const rows = await db.all<T>(query, params);
      return rows[0];
    },
    async run(query: string, params: Param[] = []) {
      const r = await sql.unsafe(toPgPlaceholders(query), params);
      return { changes: r.count };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return (await sql.begin(async (tx) =>
        fn(postgresAdapter(tx as unknown as Sql)),
      )) as T;
    },
  };
  return db;
}

export async function resetDbForTests() {
  dbPromise = null;
}
