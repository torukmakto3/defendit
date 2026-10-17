import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

const defaultPath = join(process.cwd(), "data", "defend-it.db");

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const path = process.env.DATABASE_PATH || defaultPath;
  mkdirSync(dirname(path), { recursive: true });
  dbInstance = new Database(path);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  migrate(dbInstance);
  return dbInstance;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS receivers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS defense_requests (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      receiver_id TEXT NOT NULL REFERENCES receivers(id),
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
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      text_content TEXT NOT NULL,
      claims_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES defense_requests(id),
      deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
      mode TEXT NOT NULL,
      seed TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      creator_email TEXT NOT NULL,
      plan_json TEXT,
      transcript_json TEXT,
      gap_map_json TEXT,
      integrity_json TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS grades (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      scores_json TEXT NOT NULL,
      overall_score REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS human_grades (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
      overall_score REAL NOT NULL,
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
      stamp_path TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export function resetDbForTests() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
