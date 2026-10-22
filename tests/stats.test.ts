import Database from "better-sqlite3";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "../src/app/api/stats/route";
import type { Db, Param } from "../src/lib/db";
import { getDb } from "../src/lib/db";
import { statsBearerOk, statsReport, type StatsReport } from "../src/lib/stats";

const NOW = new Date("2026-10-22T15:00:00.000Z");
const SECRET_EMAIL = "secret-person@example.com";
const SECRET_ID = "usr_secretid00000001";
const SECRET_NAME = "Secret Name";
const SECRET_SUBJECT = "Q3 memo do not leak";
const SECRET_FILE = "board-memo.pdf";

const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE defense_requests (
  id TEXT PRIMARY KEY,
  difficulty TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  voice_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  user_id TEXT,
  subject_id TEXT
);
CREATE TABLE credit_budget (
  id TEXT PRIMARY KEY,
  spent_cents INTEGER NOT NULL
);
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  budget_cents INTEGER,
  created_at TEXT NOT NULL,
  user_id TEXT
);
`;

const CHALLENGES = `
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  subject TEXT,
  slug TEXT
);
`;

function receipt(outcome: string): string {
  return JSON.stringify({
    payload: {
      outcome,
      creator: { displayName: SECRET_NAME },
      deliverable: { sha256: "abc123secret", byteLength: 12 },
    },
    signature: "sig",
  });
}

function seed(db: Database.Database, withChallenges: boolean) {
  const recent = "2026-10-22T12:00:00.000Z";
  const old = "2026-10-01T00:00:00.000Z";
  db.prepare(`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`).run(
    SECRET_ID,
    SECRET_EMAIL,
    SECRET_NAME,
    recent,
  );
  db.prepare(`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`).run(
    "usr_oldaccount000001",
    "old@example.com",
    "Old",
    old,
  );
  db.prepare(`INSERT INTO defense_requests (id, difficulty, title, created_at) VALUES (?, ?, ?, ?)`).run(
    "req_hard",
    "hard",
    SECRET_FILE,
    recent,
  );
  db.prepare(`INSERT INTO defense_requests (id, difficulty, title, created_at) VALUES (?, ?, ?, ?)`).run(
    "req_std",
    "standard",
    SECRET_FILE,
    recent,
  );
  db.prepare(`INSERT INTO defense_requests (id, difficulty, title, created_at) VALUES (?, ?, ?, ?)`).run(
    "req_exp",
    "expert",
    SECRET_FILE,
    old,
  );
  const insertReceipt = db.prepare(
    `INSERT INTO receipts (id, request_id, payload_json, created_at) VALUES (?, ?, ?, ?)`,
  );
  insertReceipt.run("rcpt_hard", "req_hard", receipt("Defended"), recent);
  insertReceipt.run("rcpt_std", "req_std", receipt("Not defended"), recent);
  insertReceipt.run("rcpt_exp", "req_exp", receipt("Defended"), old);

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, mode, status, started_at, completed_at, cost_usd, voice_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertSession.run("ses_done_new", "defend", "completed", recent, recent, 0.1, 0.05);
  insertSession.run("ses_done_old", "defend", "completed", old, old, 0.3, 0);
  insertSession.run("ses_open", "defend", "in_progress", recent, null, 9, 9);
  insertSession.run("ses_learn", "learn", "completed", recent, recent, 1, 0);

  db.prepare(`INSERT INTO analytics_events (id, name, occurred_at, user_id, subject_id) VALUES (?, ?, ?, ?, ?)`).run(
    "aev_1",
    "learn_opened",
    recent,
    SECRET_ID,
    "ses_learn",
  );
  db.prepare(`INSERT INTO analytics_events (id, name, occurred_at, user_id, subject_id) VALUES (?, ?, ?, ?, ?)`).run(
    "aev_2",
    "learn_opened",
    recent,
    SECRET_ID,
    "ses_learn",
  );
  db.prepare(`INSERT INTO analytics_events (id, name, occurred_at, user_id, subject_id) VALUES (?, ?, ?, ?, ?)`).run(
    "aev_old",
    "learn_opened",
    old,
    SECRET_ID,
    "ses_old",
  );

  db.prepare(`INSERT INTO credit_budget (id, spent_cents) VALUES ('beta', 7000)`).run();
  db.prepare(`INSERT INTO credit_ledger (id, budget_cents, created_at, user_id) VALUES (?, ?, ?, ?)`).run(
    "led_new",
    70,
    recent,
    SECRET_ID,
  );
  db.prepare(`INSERT INTO credit_ledger (id, budget_cents, created_at, user_id) VALUES (?, ?, ?, ?)`).run(
    "led_refund",
    -10,
    recent,
    SECRET_ID,
  );
  db.prepare(`INSERT INTO credit_ledger (id, budget_cents, created_at, user_id) VALUES (?, ?, ?, ?)`).run(
    "led_old",
    6930,
    old,
    SECRET_ID,
  );

  if (!withChallenges) return;
  const insertChallenge = db.prepare(
    `INSERT INTO challenges (id, status, created_at, claimed_at, subject, slug) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertChallenge.run("chg_open", "open", recent, null, SECRET_SUBJECT, "slugopen1");
  insertChallenge.run("chg_yes", "claimed", recent, recent, SECRET_SUBJECT, "slugyes01");
  insertChallenge.run("chg_no", "declined", recent, null, SECRET_SUBJECT, "slugno001");
  insertChallenge.run("chg_done", "defended", recent, recent, SECRET_SUBJECT, "slugdone1");
  insertChallenge.run("chg_exp", "expired", recent, null, SECRET_SUBJECT, "slugexp01");
  insertChallenge.run("chg_old_yes", "defended", old, recent, SECRET_SUBJECT, "slugold01");
  insertChallenge.run("chg_old_no", "declined", old, null, SECRET_SUBJECT, "slugold02");
  insertChallenge.run("chg_old_exp", "expired", old, null, SECRET_SUBJECT, "slugold03");
}

function assertNoPii(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(SECRET_EMAIL);
  expect(text).not.toContain(SECRET_ID);
  expect(text).not.toContain(SECRET_NAME);
  expect(text).not.toContain(SECRET_SUBJECT);
  expect(text).not.toContain(SECRET_FILE);
  expect(text).not.toContain("abc123secret");
  expect(text).not.toContain("slug");
  const banned = new Set([
    "email",
    "user_id",
    "userId",
    "display_name",
    "displayName",
    "file_name",
    "fileName",
    "subject",
    "slug",
    "payload",
    "signature",
    "sha256",
    "text",
    "note",
    "target_hint",
  ]);
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      expect(banned.has(key)).toBe(false);
      walk(child);
    }
  };
  walk(body);
}

describe("stats aggregates", () => {
  it("counts the window and all-time, and keeps document fields out", async () => {
    const raw = new Database(":memory:");
    raw.exec(SCHEMA + CHALLENGES);
    seed(raw, true);
    const filled: Db = {
      dialect: "sqlite",
      async all<T>(query: string, params: Param[] = []) {
        return raw.prepare(query).all(...params) as T[];
      },
      async get<T>(query: string, params: Param[] = []) {
        return raw.prepare(query).get(...params) as T | undefined;
      },
      async run(query: string, params: Param[] = []) {
        return { changes: raw.prepare(query).run(...params).changes };
      },
      async transaction(fn) {
        return fn(filled);
      },
    };

    const report = await statsReport(filled, { days: 1, now: NOW });
    expect(report.generated_at).toBe(NOW.toISOString());
    expect(report.range).toEqual({ days: 1, since: "2026-10-21T15:00:00.000Z" });
    expect(report.window).toMatchObject({
      signups: 1,
      defenses_started: 2,
      defenses_completed: 1,
      receipts_issued: 2,
      learn_opens: 2,
      beta_budget: { spent_cents: 60, total_cents: 15000, spent_eur: 0.6, total_eur: 150 },
      cost_per_completed_defense: {
        completed: 1,
        llm_usd: 0.1,
        voice_usd: 0.05,
        with_measured_voice: 1,
      },
      challenges: { sent: 5, accepted: 3, declined: 1, defended: 1, expired: 1 },
    });
    expect(report.window.pass_rate_by_tier).toEqual({
      standard: { passed: 0, completed: 1, rate: 0 },
      hard: { passed: 1, completed: 1, rate: 1 },
      expert: { passed: 0, completed: 0, rate: null },
    });
    expect(report.all_time).toMatchObject({
      signups: 2,
      defenses_started: 3,
      defenses_completed: 2,
      receipts_issued: 3,
      learn_opens: 3,
      beta_budget: { spent_cents: 7000, total_cents: 15000, spent_eur: 70, total_eur: 150 },
      cost_per_completed_defense: {
        completed: 2,
        llm_usd: 0.2,
        voice_usd: 0.025,
        with_measured_voice: 1,
      },
      challenges: { sent: 8, accepted: 3, declined: 2, defended: 2, expired: 2 },
    });
    expect(report.all_time.pass_rate_by_tier.expert).toEqual({ passed: 1, completed: 1, rate: 1 });
    assertNoPii(report);
  });

  it("returns null challenge counts when the table is missing", async () => {
    const raw = new Database(":memory:");
    raw.exec(SCHEMA);
    seed(raw, false);
    const db: Db = {
      dialect: "sqlite",
      async all<T>(query: string, params: Param[] = []) {
        return raw.prepare(query).all(...params) as T[];
      },
      async get<T>(query: string, params: Param[] = []) {
        return raw.prepare(query).get(...params) as T | undefined;
      },
      async run() {
        return { changes: 0 };
      },
      async transaction(fn) {
        return fn(db);
      },
    };
    const report = await statsReport(db, { days: "all", now: NOW });
    expect(report.range.days).toBe("all");
    expect(report.range.since).toBeNull();
    expect(report.window.challenges).toBeNull();
    expect(report.all_time.challenges).toBeNull();
    expect(report.window.signups).toBe(report.all_time.signups);
    assertNoPii(report);
  });

  it("reads numeric strings the way Postgres returns bigint sums", async () => {
    const db: Db = {
      dialect: "postgres",
      async all<T>() {
        return [] as T[];
      },
      async get<T>(sql: string) {
        if (sql.includes("to_regclass")) return { present: "challenges" } as T;
        if (sql.includes("SUM(cost_usd)")) return { n: "2", llm: "0.20", voice: "0.05", voiced: "1" } as T;
        if (sql.includes("credit_budget")) return { n: "7000" } as T;
        if (sql.includes("credit_ledger")) return { n: "60" } as T;
        return { n: "4" } as T;
      },
      async run() {
        return { changes: 0 };
      },
      async transaction(fn) {
        return fn(db);
      },
    };
    const report = await statsReport(db, { days: 1, now: NOW });
    expect(report.window.signups).toBe(4);
    expect(report.window.beta_budget.spent_cents).toBe(60);
    expect(report.all_time.beta_budget.spent_cents).toBe(7000);
    expect(report.all_time.cost_per_completed_defense.llm_usd).toBe(0.1);
    expect(report.window.challenges).toEqual({
      sent: 4,
      accepted: 4,
      declined: 4,
      defended: 4,
      expired: 4,
    });
  });
});

describe("GET /api/stats", () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "defendit-stats-"));
    process.env.DATABASE_PATH = join(dir, "stats.db");
    delete process.env.DATABASE_URL;
    process.env.STATS_TOKEN = "stats-test-token";
    delete process.env.BETA_BUDGET_EUR;
  });

  function call(headers: Record<string, string> = {}, days?: string) {
    const query = days == null ? "" : `?days=${days}`;
    return GET(
      new Request(`http://localhost:3000/api/stats${query}`, {
        headers: { "x-forwarded-for": "203.0.113.9", ...headers },
      }),
    );
  }

  it("answers 404 when STATS_TOKEN is unset and 401 when the bearer is wrong", async () => {
    delete process.env.STATS_TOKEN;
    const missing = await call();
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    process.env.STATS_TOKEN = "stats-test-token";

    const none = await call();
    expect(none.status).toBe(401);
    const wrong = await call({ authorization: "Bearer not-the-token" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("cache-control")).toBe("no-store");
    expect(statsBearerOk("Bearer stats-test-token", "stats-test-token")).toBe(true);
    expect(statsBearerOk("Bearer other", "stats-test-token")).toBe(false);
  });

  it("returns the aggregate shape and no stored identifiers", async () => {
    const res = await call({ authorization: "Bearer stats-test-token" }, "all");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as StatsReport;
    expect(body.range.days).toBe("all");
    expect(body.window.challenges).toEqual({
      sent: 0,
      accepted: 0,
      declined: 0,
      defended: 0,
      expired: 0,
    });
    expect(body.all_time.beta_budget.total_eur).toBe(150);
    expect(body.all_time.pass_rate_by_tier.standard.rate).toBeNull();
    expect(Object.keys(body).sort()).toEqual(["all_time", "generated_at", "range", "window"]);
    assertNoPii(body);
  });

  it("rejects a bad days query and rate limits the 61st request from one IP", async () => {
    const bad = await call({ authorization: "Bearer stats-test-token" }, "0");
    expect(bad.status).toBe(400);

    const db = await getDb();
    await db.run(
      `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, ?)
       ON CONFLICT (bucket_key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
      ["stats:203.0.113.50", new Date().toISOString(), 60],
    );
    const limited = await GET(
      new Request("http://localhost:3000/api/stats", {
        headers: {
          authorization: "Bearer stats-test-token",
          "x-forwarded-for": "203.0.113.50",
        },
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });
});
