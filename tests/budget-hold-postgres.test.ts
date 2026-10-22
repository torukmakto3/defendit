import { describe, expect, it } from "vitest";
import type { Db, Param } from "../src/lib/db";
import { claimBudgetHold } from "../src/lib/llm/usage";

/**
 * Postgres stand-in for the cap hold.
 *
 * READ COMMITTED keeps the snapshot a statement took when it started. A
 * `FOR UPDATE` in that same statement re-reads the locked row after waiting,
 * and still sums `budget_holds` from the old snapshot, so two claims can both
 * insert. This fake does that on purpose: the lock waits, and a combined
 * insert keeps the pre-lock snapshot. A later statement sees holds committed
 * by the transaction that released the lock.
 */
interface Hold {
  id: string;
  session_id: string;
  usd: number;
  grades: number;
  created_at: string;
}

function fakePostgres() {
  const committed: Hold[] = [];
  let tail: Promise<void> = Promise.resolve();
  const statements: string[] = [];
  const session = {
    id: "ses_pg",
    voice_cost_usd: 0,
    budget_usd: 0.05,
  };

  function acquire(): Promise<() => void> {
    let release!: () => void;
    const prev = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(() => release);
  }

  function visible(snapshot: Hold[], txInserts: Hold[], deletedBefore: Map<string, string>): Hold[] {
    return [...snapshot, ...txInserts].filter((hold) => {
      const cutoff = deletedBefore.get(hold.session_id);
      return cutoff === undefined || hold.created_at > cutoff;
    });
  }

  const db: Db = {
    dialect: "postgres",
    async all<T>(): Promise<T[]> {
      return [];
    },
    async get<T>(): Promise<T | undefined> {
      return undefined;
    },
    async run(): Promise<{ changes: number }> {
      return { changes: 0 };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const txInserts: Hold[] = [];
      const deletedBefore = new Map<string, string>();
      const gate: { unlock: (() => void) | null } = { unlock: null };
      let preLockHolds: Hold[] | null = null;

      const tx: Db = {
        dialect: "postgres",
        async all<U>(): Promise<U[]> {
          return [];
        },
        async get<U>(sql: string, params: Param[] = []): Promise<U | undefined> {
          statements.push(sql);
          if (!sql.includes("FOR UPDATE")) return undefined;
          if (sql.includes("budget_holds") || sql.includes("INSERT")) preLockHolds = committed.slice();
          gate.unlock = await acquire();
          if (String(params[0]) !== session.id) return undefined;
          return { id: session.id } as U;
        },
        async run(sql: string, params: Param[] = []): Promise<{ changes: number }> {
          statements.push(sql);
          if (sql.startsWith("DELETE FROM budget_holds")) {
            deletedBefore.set(String(params[0]), String(params[1]));
            return { changes: 0 };
          }
          if (sql.includes("INSERT INTO budget_holds")) {
            const combined = sql.includes("FOR UPDATE");
            if (combined && !gate.unlock) {
              preLockHolds = committed.slice();
              gate.unlock = await acquire();
            }
            const snapshot = combined && preLockHolds ? preLockHolds : committed.slice();
            const sessionId = String(params[4]);
            if (sessionId !== session.id) return { changes: 0 };
            const cutoff = String(params[5]);
            const live = visible(snapshot, txInserts, deletedBefore).filter(
              (hold) => hold.session_id === sessionId && hold.created_at > cutoff,
            );
            const spent = session.voice_cost_usd + live.reduce((sum, hold) => sum + hold.usd, 0) + Number(params[6]);
            const cap = session.budget_usd;
            const under = spent <= cap + 0.000001;
            const grades = live.reduce((sum, hold) => sum + hold.grades, 0);
            const over = Number(params[8]) === 1 && grades === 0;
            if (!under && !over) return { changes: 0 };
            txInserts.push({
              id: String(params[0]),
              session_id: sessionId,
              usd: Number(params[1]),
              grades: Number(params[2]),
              created_at: String(params[3]),
            });
            return { changes: 1 };
          }
          if (sql.includes("UPDATE sessions SET")) return { changes: 1 };
          return { changes: 0 };
        },
        transaction<U>(inner: (nested: Db) => Promise<U>): Promise<U> {
          return inner(tx);
        },
      };

      try {
        const out = await fn(tx);
        const kept = committed.filter((hold) => {
          const cutoff = deletedBefore.get(hold.session_id);
          return cutoff === undefined || hold.created_at > cutoff;
        });
        committed.splice(0, committed.length, ...kept, ...txInserts);
        return out;
      } finally {
        gate.unlock?.();
      }
    },
  };

  return { db, statements, holds: () => committed.map((hold) => hold.id) };
}

describe("postgres budget hold", () => {
  it("lets only one of two concurrent claims take the last slice", async () => {
    const pg = fakePostgres();
    const claim = (holdId: string) =>
      claimBudgetHold(pg.db, {
        sessionId: "ses_pg",
        holdId,
        estimate: 0.05,
        gradeDelta: 0,
        allowOver: 0,
        budgetFallback: 0.05,
      });

    const [first, second] = await Promise.all([claim("hold_a"), claim("hold_b")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(pg.holds()).toHaveLength(1);

    const locks = pg.statements.filter((sql) => sql.includes("FOR UPDATE"));
    expect(locks.length).toBeGreaterThanOrEqual(2);
    for (const sql of locks) expect(sql.includes("INSERT")).toBe(false);
    const inserts = pg.statements.filter((sql) => sql.includes("INSERT INTO budget_holds"));
    expect(inserts.length).toBe(2);
    for (const sql of inserts) expect(sql.includes("FOR UPDATE")).toBe(false);
  });

  it("refuses a hold when the session row is missing", async () => {
    const pg = fakePostgres();
    const claimed = await claimBudgetHold(pg.db, {
      sessionId: "ses_missing",
      holdId: "hold_missing",
      estimate: 0.01,
      gradeDelta: 0,
      allowOver: 0,
      budgetFallback: 0.05,
    });
    expect(claimed).toBe(false);
    expect(pg.holds()).toHaveLength(0);
  });
});
