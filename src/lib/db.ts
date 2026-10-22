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
`;

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
  raw.exec(SCHEMA.replaceAll("DOUBLE PRECISION", "REAL"));
  for (const [table, column, def] of ADDED_COLUMNS) {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  return sqliteAdapter(raw);
}

function sqliteAdapter(raw: BetterSqlite3.Database): Db {
  let depth = 0;
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
      // better-sqlite3 is synchronous and single-connection; nested calls
      // join the outer transaction.
      if (depth > 0) return fn(db);
      depth++;
      raw.exec("BEGIN");
      try {
        const out = await fn(db);
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
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
