/**
 * Credit ledger. Balance for a kind is the sum of `credit_ledger.amount`.
 * Rows are append-only. Every write has an idempotency key.
 *
 * #37 (challenge links) calls these five functions. Pass `db` only from
 * inside an open `db.transaction` so the write commits or rolls back with
 * the caller's rows. Omit `db` and the function opens its own transaction.
 *
 * Refunds always return credit to the wallet (`REFUND_DESTINATION`).
 * There is no card payout.
 *
 * ```
 * getBalance(userId: string, db?: Db): Promise<CreditBalance>
 * holdCredit(input: HoldCreditInput): Promise<LedgerEntry>
 * consumeCredit(input: ConsumeCreditInput): Promise<LedgerEntry>
 * refundCredit(input: RefundCreditInput): Promise<LedgerEntry>
 * grantCredits(input: GrantCreditsInput): Promise<LedgerEntry>
 * ```
 *
 * `getBalance().defense` and `.challenge` are what that action can spend.
 * Both include `flex` (pack credits, usable for either). They are not two
 * piles you add together. `defenseOnly` and `challengeOnly` leave flex out.
 *
 * A hold debits the wallet. Consuming a hold writes a zero-amount row so
 * the credit is not debited twice. Refunding a hold or a consumed credit
 * writes a positive row of the same kind and source.
 *
 * Draw order for a defense: subscription, purchase, overage, admin, then
 * flexible packs, then sponsored beta credits. Sponsored defense holds
 * count `BETA_DEFENSE_EUR` (default 0.70, about the $0.75 consumer cap)
 * against `BETA_BUDGET_EUR` (default 150). A beta challenge defense reserves
 * that same amount when the defense starts, without spending the defender's
 * defense credit, and releases it on decline, expiry, or revoke.
 * Challenge-credit holds do not count against the budget. A no-login sample
 * demo charges the same `BETA_DEFENSE_EUR` through `chargeBetaDefenseBudget`
 * with purpose `demo`, against `DEMO_BUDGET_EUR` (default 20, lifetime) on
 * `credit_budget` id `demo`. That charge does not move the shared `beta`
 * row, so samples cannot exhaust `BETA_BUDGET_EUR`. Each account
 * is granted `BETA_DEFENSE_CREDITS` free defenses once (default 3). While
 * billing is off, the next defense after those are spent is a 402. The
 * global budget can stop a sponsored defense sooner. Starting a defense
 * refunds an unfinished hold that is already attached to an in-progress
 * session, or an unattached hold older than two minutes. A fresh unattached
 * hold from a concurrent start is left alone. That refund does not take
 * back the challenge-defense reservation: a newer start still needs it.
 *
 * #42 reads the cost-cap tier from `costTierForUser(userId)` or
 * `costTierForUserPlan(planId)`. `consumer` is $0.75 and `enterprise` is
 * $3 (`src/lib/plans.ts`). This module does not enforce the cap.
 */

import { demoBudgetEur, isDemoPrincipalEmail } from "./demo-policy";
import { getDb, type Db } from "./db";
import { HttpError } from "./errors";
import { newId } from "./ids";
import {
  BETA_GRANT,
  betaDefenseCredits,
  billingEnabled,
  costTierForPlan,
  formatEur,
  getPlan,
  isPlanId,
  ONWARD_CHALLENGE_CREDITS,
  PACKS,
  PAYG_CENTS,
  periodsForInterval,
  type BillingInterval,
  type CostCapTier,
  type Plan,
  type PlanId,
} from "./plans";

export const REFUND_DESTINATION = "credit" as const;

export type CreditKind = "defense" | "challenge" | "learn_slot";
export type LedgerKind = CreditKind | "flex";
export type SpendKind = "defense" | "challenge";
export type LedgerReason =
  | "grant"
  | "purchase"
  | "subscription_renewal"
  | "hold"
  | "consume"
  | "refund"
  | "expire"
  | "admin_adjust";
export type GrantReason = "grant" | "purchase" | "subscription_renewal" | "admin_adjust";
export type CreditSource =
  | "beta"
  | "purchase"
  | "pack"
  | "subscription"
  | "onward"
  | "overage"
  | "admin";

export interface CreditBalance {
  /** Spendable on a defense: defense-only plus flexible. */
  defense: number;
  /** Spendable on a challenge: challenge-only plus flexible. */
  challenge: number;
  /** Included in both defense and challenge. */
  flex: number;
  defenseOnly: number;
  challengeOnly: number;
  /** Learn project capacity. Active projects are counted separately. */
  learnSlots: number;
  /** Open holds. Already subtracted from the numbers above. */
  held: { defense: number; challenge: number };
}

export interface LedgerEntry {
  id: string;
  userId: string;
  kind: LedgerKind;
  reason: LedgerReason;
  amount: number;
  idempotencyKey: string;
  source: CreditSource | null;
  purpose: string | null;
  refType: string | null;
  refId: string | null;
  sponsored: boolean;
  budgetCents: number | null;
  createdAt: string;
}

export interface HoldCreditInput {
  userId: string;
  kind: SpendKind;
  /** Defaults to 1. A defense and a challenge each cost 1. */
  amount?: number;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  db?: Db;
}

export interface ConsumeCreditInput {
  userId: string;
  idempotencyKey: string;
  /** Settle this hold (no second debit). Omit to debit `kind` now. */
  holdIdempotencyKey?: string;
  kind?: SpendKind;
  amount?: number;
  refType?: string;
  refId?: string;
  db?: Db;
}

export interface RefundCreditInput {
  userId: string;
  /** Idempotency key of the hold or consume being reversed. */
  entryIdempotencyKey: string;
  idempotencyKey: string;
  db?: Db;
}

export interface GrantCreditsInput {
  userId: string;
  kind: LedgerKind;
  amount: number;
  reason: GrantReason;
  idempotencyKey: string;
  source?: CreditSource;
  sponsored?: boolean;
  refType?: string;
  refId?: string;
  periodId?: string;
  db?: Db;
}

export interface AssignedPlan {
  plan: Plan;
  interval: BillingInterval | null;
  status: "active" | "canceled" | "none";
  /** consumer or enterprise. The cost-cap reads this. It is not enforced here. */
  costTier: CostCapTier;
  periodId: string | null;
}

interface LedgerRow {
  id: string;
  user_id: string;
  kind: string;
  reason: string;
  amount: number | string;
  idempotency_key: string;
  source: string | null;
  purpose: string | null;
  ref_type: string | null;
  ref_id: string | null;
  sponsored: number | string;
  budget_cents: number | string | null;
  period_id: string | null;
  created_at: string;
}

interface Insert {
  userId: string;
  kind: LedgerKind;
  reason: LedgerReason;
  amount: number;
  idempotencyKey: string;
  source: CreditSource | null;
  purpose: string | null;
  refType: string | null;
  refId: string | null;
  sponsored: boolean;
  budgetCents: number | null;
  periodId: string | null;
}

interface DrawSlot {
  kind: "defense" | "challenge" | "flex";
  source: CreditSource;
  sponsored: boolean;
}

const DEFENSE_DRAW: DrawSlot[] = [
  { kind: "defense", source: "subscription", sponsored: false },
  { kind: "defense", source: "purchase", sponsored: false },
  { kind: "defense", source: "overage", sponsored: false },
  { kind: "defense", source: "admin", sponsored: false },
  { kind: "flex", source: "pack", sponsored: false },
  { kind: "flex", source: "purchase", sponsored: false },
  { kind: "flex", source: "admin", sponsored: false },
  { kind: "defense", source: "beta", sponsored: true },
  { kind: "flex", source: "beta", sponsored: true },
];

const CHALLENGE_DRAW: DrawSlot[] = [
  { kind: "challenge", source: "subscription", sponsored: false },
  { kind: "challenge", source: "purchase", sponsored: false },
  { kind: "challenge", source: "admin", sponsored: false },
  { kind: "flex", source: "pack", sponsored: false },
  { kind: "flex", source: "purchase", sponsored: false },
  { kind: "flex", source: "admin", sponsored: false },
  { kind: "challenge", source: "onward", sponsored: true },
  { kind: "challenge", source: "beta", sponsored: true },
  { kind: "flex", source: "beta", sponsored: true },
];

function drawOrder(purpose: SpendKind): DrawSlot[] {
  switch (purpose) {
    case "defense":
      return DEFENSE_DRAW;
    case "challenge":
      return CHALLENGE_DRAW;
    default: {
      const unknown: never = purpose;
      return unknown;
    }
  }
}

function num(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function betaBudgetCents(): number {
  return Math.round(envNonNegative("BETA_BUDGET_EUR", 150) * 100);
}

export function betaDefenseCents(): number {
  return Math.round(envNonNegative("BETA_DEFENSE_EUR", 0.7) * 100);
}

function envNonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = "code" in e ? String(e.code) : "";
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505") return true;
  const message = e instanceof Error ? e.message : "";
  return /UNIQUE constraint failed|duplicate key value/i.test(message);
}

async function withTx<T>(db: Db | undefined, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (db) return fn(db);
  const conn = await getDb();
  return conn.transaction(fn);
}

async function lockWallet(tx: Db, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await tx.run(
    `INSERT INTO credit_wallets (user_id, lock_nonce, created_at) VALUES (?, 0, ?)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, now],
  );
  const locked = await tx.run(`UPDATE credit_wallets SET lock_nonce = lock_nonce + 1 WHERE user_id = ?`, [
    userId,
  ]);
  if (locked.changes !== 1) throw new HttpError(500, "Could not lock the credit wallet");
}

function mapRow(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as LedgerKind,
    reason: row.reason as LedgerReason,
    amount: num(row.amount),
    idempotencyKey: row.idempotency_key,
    source: (row.source as CreditSource | null) ?? null,
    purpose: row.purpose,
    refType: row.ref_type,
    refId: row.ref_id,
    sponsored: num(row.sponsored) === 1,
    budgetCents: row.budget_cents == null ? null : num(row.budget_cents),
    createdAt: row.created_at,
  };
}

function conflicts(row: LedgerRow, input: Insert): boolean {
  return (
    row.user_id !== input.userId ||
    row.kind !== input.kind ||
    row.reason !== input.reason ||
    num(row.amount) !== input.amount ||
    (row.source ?? null) !== input.source
  );
}

async function insertEntry(tx: Db, input: Insert): Promise<LedgerEntry> {
  return (await insertEntryOnce(tx, input)).entry;
}

/** `inserted` is false when this idempotency key was already stored. */
async function insertEntryOnce(tx: Db, input: Insert): Promise<{ entry: LedgerEntry; inserted: boolean }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new HttpError(400, "Idempotency key is missing.");
  }
  if (!Number.isSafeInteger(input.amount)) throw new HttpError(400, "Credit amount is not a whole number.");
  const tracksBudget = input.budgetCents != null && input.budgetCents !== 0;
  if (input.amount === 0 && input.reason !== "consume" && !tracksBudget) {
    throw new HttpError(400, "Credit amount must be non-zero.");
  }
  const existing = await tx.get<LedgerRow>(`SELECT * FROM credit_ledger WHERE idempotency_key = ?`, [
    input.idempotencyKey,
  ]);
  if (existing) {
    if (conflicts(existing, input)) throw new HttpError(409, "That idempotency key was already used.");
    return { entry: mapRow(existing), inserted: false };
  }
  if (input.amount < 0 && input.source) {
    const have = await sumBucket(tx, input.userId, input.kind, input.source);
    if (have + input.amount < 0) throw new HttpError(402, "Not enough credits.");
  }
  const id = newId("led");
  const now = new Date().toISOString();
  try {
    await tx.run(
      `INSERT INTO credit_ledger
        (id, user_id, kind, reason, amount, idempotency_key, source, purpose, ref_type, ref_id,
         sponsored, budget_cents, period_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.kind,
        input.reason,
        input.amount,
        input.idempotencyKey,
        input.source,
        input.purpose,
        input.refType,
        input.refId,
        input.sponsored ? 1 : 0,
        input.budgetCents,
        input.periodId,
        now,
      ],
    );
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const raced = await tx.get<LedgerRow>(`SELECT * FROM credit_ledger WHERE idempotency_key = ?`, [
      input.idempotencyKey,
    ]);
    if (!raced || conflicts(raced, input)) throw new HttpError(409, "That idempotency key was already used.");
    return { entry: mapRow(raced), inserted: false };
  }
  const row = await tx.get<LedgerRow>(`SELECT * FROM credit_ledger WHERE id = ?`, [id]);
  if (!row) throw new HttpError(500, "Credit entry was not stored");
  return { entry: mapRow(row), inserted: true };
}

async function sumBucket(db: Db, userId: string, kind: string, source: string): Promise<number> {
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM credit_ledger WHERE user_id = ? AND kind = ? AND source = ?`,
    [userId, kind, source],
  );
  return num(row?.n);
}

async function sumKind(db: Db, userId: string, kind: string): Promise<number> {
  const row = await db.get<{ n: number | string | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM credit_ledger WHERE user_id = ? AND kind = ?`,
    [userId, kind],
  );
  return num(row?.n);
}

async function loadBuckets(db: Db, userId: string): Promise<Map<string, number>> {
  const rows = await db.all<{ kind: string; source: string | null; n: number | string }>(
    `SELECT kind, source, COALESCE(SUM(amount), 0) AS n FROM credit_ledger WHERE user_id = ? GROUP BY kind, source`,
    [userId],
  );
  const map = new Map<string, number>();
  for (const row of rows) map.set(`${row.kind}:${row.source ?? ""}`, num(row.n));
  return map;
}

function pickBucket(buckets: Map<string, number>, purpose: SpendKind, amount: number): DrawSlot | null {
  for (const slot of drawOrder(purpose)) {
    const have = buckets.get(`${slot.kind}:${slot.source}`) ?? 0;
    if (have >= amount) return slot;
  }
  return null;
}

const BETA_BUDGET_ID = "beta";
const DEMO_BUDGET_ID = "demo";

/** Ledger cents that belong on the shared beta row. Sample rows stay out. */
const BETA_BUDGET_SEED = `COALESCE((SELECT SUM(budget_cents) FROM credit_ledger WHERE purpose IS NULL OR purpose <> 'demo'), 0)`;
/** Ledger cents that belong on the sample lifetime cap. */
const DEMO_BUDGET_SEED = `COALESCE((SELECT SUM(budget_cents) FROM credit_ledger WHERE purpose = 'demo'), 0)`;

export function demoBudgetCents(): number {
  return Math.round(demoBudgetEur() * 100);
}

/**
 * Whether another sponsored defense of `costCents` still fits. A read, so
 * the sample path can refuse before it spends a rate-limit slot. The charge
 * itself is `chargeBetaDefenseBudget`.
 */
export async function betaBudgetCanAfford(costCents: number): Promise<boolean> {
  if (costCents < 0) return false;
  const db = await getDb();
  const row = await db.get<{ spent_cents: number | string | null }>(
    `SELECT spent_cents FROM credit_budget WHERE id = ?`,
    [BETA_BUDGET_ID],
  );
  const spent = row
    ? num(row.spent_cents)
    : num(
        (
          await db.get<{ n: number | string | null }>(
            `SELECT ${BETA_BUDGET_SEED} AS n`,
          )
        )?.n,
      );
  return spent + costCents <= betaBudgetCents();
}

/**
 * Whether another sample of `costCents` still fits in `DEMO_BUDGET_EUR`.
 * A read, so admission can refuse before it spends a rate-limit slot.
 * The charge itself is `chargeBetaDefenseBudget` with purpose `demo`.
 */
export async function demoBudgetCanAfford(costCents: number): Promise<boolean> {
  if (costCents < 0) return false;
  const db = await getDb();
  const row = await db.get<{ spent_cents: number | string | null }>(
    `SELECT spent_cents FROM credit_budget WHERE id = ?`,
    [DEMO_BUDGET_ID],
  );
  const spent = row
    ? num(row.spent_cents)
    : num((await db.get<{ n: number | string | null }>(`SELECT ${DEMO_BUDGET_SEED} AS n`))?.n);
  return spent + costCents <= demoBudgetCents();
}

/**
 * Count one sample demo against `DEMO_BUDGET_EUR`. The shared beta row is
 * not updated. Writes a zero-amount ledger row with purpose `demo` so a
 * later reseed of the demo budget still includes the charge. Does not grant
 * or spend a wallet credit.
 */
export async function chargeBetaDefenseBudget(input: {
  userId: string;
  idempotencyKey: string;
  refId: string;
  db?: Db;
}): Promise<boolean> {
  return withTx(input.db, async (tx) => {
    const existing = await tx.get<{ id: string }>(
      `SELECT id FROM credit_ledger WHERE idempotency_key = ?`,
      [input.idempotencyKey],
    );
    if (existing) return true;
    const cost = betaDefenseCents();
    const purpose = "demo" as const;
    if (!(await reserveForPurpose(tx, purpose, cost))) return false;
    await insertEntry(tx, {
      userId: input.userId,
      kind: "defense",
      reason: "consume",
      amount: 0,
      idempotencyKey: input.idempotencyKey,
      source: "beta",
      purpose,
      refType: "demo",
      refId: input.refId,
      sponsored: true,
      budgetCents: cost,
      periodId: null,
    });
    return true;
  });
}

/**
 * Claim `costCents` of the global beta budget, or return false when it would
 * pass the cap. One conditional UPDATE, so a second account blocks on the
 * `credit_budget` row in Postgres and sees the first write. SQLite applies
 * the same statement under its writer lock.
 */
async function reserveBetaBudget(tx: Db, costCents: number): Promise<boolean> {
  return reserveBudgetRow(tx, BETA_BUDGET_ID, costCents, betaBudgetCents(), BETA_BUDGET_SEED);
}

/** purpose `demo` draws the sample cap. Any other purpose is a type error. */
async function reserveForPurpose(tx: Db, purpose: "demo", costCents: number): Promise<boolean> {
  switch (purpose) {
    case "demo":
      return reserveDemoBudget(tx, costCents);
    default: {
      const unknown: never = purpose;
      return unknown;
    }
  }
}

/** Claim `costCents` of the sample lifetime cap. Does not touch id `beta`. */
async function reserveDemoBudget(tx: Db, costCents: number): Promise<boolean> {
  return reserveBudgetRow(tx, DEMO_BUDGET_ID, costCents, demoBudgetCents(), DEMO_BUDGET_SEED);
}

async function reserveBudgetRow(
  tx: Db,
  id: string,
  costCents: number,
  capCents: number,
  seedSql: string,
): Promise<boolean> {
  if (costCents < 0) return false;
  await tx.run(
    `INSERT INTO credit_budget (id, spent_cents)
     VALUES (?, ${seedSql})
     ON CONFLICT (id) DO NOTHING`,
    [id],
  );
  const updated = await tx.run(
    `UPDATE credit_budget
     SET spent_cents = spent_cents + ?
     WHERE id = ? AND spent_cents + ? <= ?`,
    [costCents, id, costCents, capCents],
  );
  return updated.changes === 1;
}

/** Serialize budget writers. The following read of the ledger then sees a reservation that just committed. */
async function lockBetaBudget(tx: Db): Promise<void> {
  await tx.run(
    `INSERT INTO credit_budget (id, spent_cents)
     VALUES (?, ${BETA_BUDGET_SEED})
     ON CONFLICT (id) DO NOTHING`,
    [BETA_BUDGET_ID],
  );
  await tx.run(`UPDATE credit_budget SET spent_cents = spent_cents WHERE id = ?`, [BETA_BUDGET_ID]);
}

function challengeDefenseBudgetKey(challengeId: string): string {
  return `budget:challenge-defense:${challengeId}`;
}

function challengeDefenseBudgetReleaseKey(challengeId: string): string {
  return `budget-release:challenge-defense:${challengeId}`;
}

/**
 * Count one beta challenge defense against `BETA_BUDGET_EUR`. The defender's
 * defense credit is not spent. A repeat start for the same challenge does
 * not reserve twice, and a start replaced by a newer one does not release
 * this row: the newer start still needs it. Decline, expiry, and revoke do.
 * Paid challenges are not sponsored by this budget.
 */
export async function reserveChallengeDefenseBudget(requestId: string, userId: string): Promise<void> {
  const db = await getDb();
  const row = await db.get<{ id: string; sponsor_type: string; claimed_by_user_id: string | null }>(
    `SELECT id, sponsor_type, claimed_by_user_id FROM challenges WHERE request_id = ?`,
    [requestId],
  );
  if (!row || row.sponsor_type !== "beta" || row.claimed_by_user_id !== userId) return;
  const key = challengeDefenseBudgetKey(row.id);
  const cost = betaDefenseCents();
  await withTx(undefined, async (tx) => {
    await lockBetaBudget(tx);
    const existing = await tx.get<LedgerRow>(`SELECT * FROM credit_ledger WHERE idempotency_key = ?`, [key]);
    if (existing) return;
    const released = await tx.get<{ id: string }>(
      `SELECT id FROM credit_ledger WHERE idempotency_key = ?`,
      [challengeDefenseBudgetReleaseKey(row.id)],
    );
    if (released) return;
    if (!(await reserveBetaBudget(tx, cost))) {
      throw new HttpError(402, "The beta budget is used up, so sponsored defenses are paused.");
    }
    await insertEntry(tx, {
      userId,
      kind: "defense",
      reason: "hold",
      amount: 0,
      idempotencyKey: key,
      source: "beta",
      purpose: "defense",
      refType: "challenge_defense",
      refId: row.id,
      sponsored: true,
      budgetCents: cost,
      periodId: null,
    });
  });
}

/**
 * Give a challenge-defense reservation back. No reservation means nothing to
 * release. `spent_cents` moves only when this call stores the release row.
 * A second caller finds that idempotency key and leaves the counter alone.
 * The budget row is locked first, so the seed sum does not include this release.
 */
export async function releaseChallengeDefenseBudget(challengeId: string, db?: Db): Promise<void> {
  const key = challengeDefenseBudgetKey(challengeId);
  const releaseKey = challengeDefenseBudgetReleaseKey(challengeId);
  await withTx(db, async (tx) => {
    await lockBetaBudget(tx);
    const reserved = await tx.get<LedgerRow>(`SELECT * FROM credit_ledger WHERE idempotency_key = ?`, [key]);
    if (!reserved) return;
    const cost = num(reserved.budget_cents);
    if (cost <= 0) return;
    const stored = await insertEntryOnce(tx, {
      userId: reserved.user_id,
      kind: "defense",
      reason: "refund",
      amount: 0,
      idempotencyKey: releaseKey,
      source: "beta",
      purpose: "defense",
      refType: "challenge_defense",
      refId: challengeId,
      sponsored: true,
      budgetCents: -cost,
      periodId: null,
    });
    if (!stored.inserted) return;
    await releaseBetaBudget(tx, cost);
  });
}

/** Give budget back. Call before the refund row is inserted, so the seed SUM does not already include it. */
async function releaseBetaBudget(tx: Db, costCents: number): Promise<void> {
  if (costCents <= 0) return;
  await tx.run(
    `INSERT INTO credit_budget (id, spent_cents)
     VALUES (?, ${BETA_BUDGET_SEED})
     ON CONFLICT (id) DO NOTHING`,
    [BETA_BUDGET_ID],
  );
  await tx.run(
    `UPDATE credit_budget
     SET spent_cents = CASE WHEN spent_cents >= ? THEN spent_cents - ? ELSE 0 END
     WHERE id = ?`,
    [costCents, costCents, BETA_BUDGET_ID],
  );
}

async function assignedPlan(db: Db, userId: string): Promise<AssignedPlan> {
  const row = await db.get<{
    plan_id: string;
    interval: string | null;
    status: string;
    period_id: string | null;
  }>(`SELECT plan_id, interval, status, period_id FROM user_plans WHERE user_id = ?`, [userId]);
  if (!row || !isPlanId(row.plan_id)) {
    const plan = getPlan("beta");
    return { plan, interval: null, status: "none", costTier: plan.costTier, periodId: null };
  }
  const plan = getPlan(row.plan_id);
  const interval = row.interval === "month" || row.interval === "year" ? row.interval : null;
  const status = row.status === "active" || row.status === "canceled" ? row.status : "none";
  return { plan, interval, status, costTier: plan.costTier, periodId: row.period_id };
}

function defaultSource(reason: GrantReason, sponsored: boolean): CreditSource {
  switch (reason) {
    case "grant":
      return sponsored ? "beta" : "admin";
    case "purchase":
      return "purchase";
    case "subscription_renewal":
      return "subscription";
    case "admin_adjust":
      return "admin";
    default: {
      const unknown: never = reason;
      return unknown;
    }
  }
}

function requireOneCredit(amount: number | undefined): number {
  const n = amount ?? 1;
  if (n !== 1) throw new HttpError(400, "A defense or a challenge costs 1 credit.");
  return n;
}

export async function getBalance(userId: string, db?: Db): Promise<CreditBalance> {
  const conn = db ?? (await getDb());
  const rows = await conn.all<{ kind: string; n: number | string }>(
    `SELECT kind, COALESCE(SUM(amount), 0) AS n FROM credit_ledger WHERE user_id = ? GROUP BY kind`,
    [userId],
  );
  const byKind = new Map(rows.map((row) => [row.kind, num(row.n)]));
  const defenseOnly = byKind.get("defense") ?? 0;
  const challengeOnly = byKind.get("challenge") ?? 0;
  const flex = byKind.get("flex") ?? 0;
  const heldRows = await conn.all<{ purpose: string | null; n: number | string }>(
    `SELECT l.purpose, COALESCE(SUM(-l.amount), 0) AS n
     FROM credit_ledger l
     WHERE l.user_id = ? AND l.reason = 'hold' AND l.amount < 0
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger c
         WHERE c.ref_type = 'hold' AND c.ref_id = l.id AND c.reason IN ('consume', 'refund')
       )
     GROUP BY l.purpose`,
    [userId],
  );
  const held = { defense: 0, challenge: 0 };
  for (const row of heldRows) {
    if (row.purpose === "defense" || row.purpose === "challenge") held[row.purpose] = num(row.n);
  }
  return {
    defense: defenseOnly + flex,
    challenge: challengeOnly + flex,
    flex,
    defenseOnly,
    challengeOnly,
    learnSlots: byKind.get("learn_slot") ?? 0,
    held,
  };
}

export async function grantCredits(input: GrantCreditsInput): Promise<LedgerEntry> {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new HttpError(400, "Credit amount must be a non-zero whole number.");
  }
  if (input.reason !== "admin_adjust" && input.amount < 0) {
    throw new HttpError(400, "Only an adjustment can remove credits.");
  }
  const source = input.source ?? defaultSource(input.reason, input.sponsored ?? false);
  const sponsored = input.sponsored ?? (source === "beta" || source === "onward");
  return withTx(input.db, async (tx) => {
    await lockWallet(tx, input.userId);
    return insertEntry(tx, {
      userId: input.userId,
      kind: input.kind,
      reason: input.reason,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      source,
      purpose: null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      sponsored,
      budgetCents: null,
      periodId: input.periodId ?? null,
    });
  });
}

export async function holdCredit(input: HoldCreditInput): Promise<LedgerEntry> {
  const amount = requireOneCredit(input.amount);
  return withTx(input.db, async (tx) => {
    await lockWallet(tx, input.userId);
    const existing = await tx.get<LedgerRow>(`SELECT * FROM credit_ledger WHERE idempotency_key = ?`, [
      input.idempotencyKey,
    ]);
    if (existing) {
      if (existing.user_id !== input.userId || existing.reason !== "hold") {
        throw new HttpError(409, "That idempotency key was already used.");
      }
      return mapRow(existing);
    }
    let slot = pickBucket(await loadBuckets(tx, input.userId), input.kind, amount);
    if (!slot && input.kind === "defense" && !billingEnabled()) {
      const n = betaDefenseCredits();
      const noun = n === 1 ? "defense" : "defenses";
      throw new HttpError(402, `You've used your ${n} free beta ${noun}`);
    }
    if (!slot && input.kind === "defense") {
      slot = await maybeOverage(tx, input.userId, input.idempotencyKey);
    }
    if (!slot) {
      throw new HttpError(
        402,
        input.kind === "defense"
          ? "You need a defense credit to start a defense."
          : "You need a challenge credit.",
      );
    }
    let budgetCents: number | null = null;
    if (slot.sponsored && input.kind === "defense") {
      const cost = betaDefenseCents();
      if (!(await reserveBetaBudget(tx, cost))) {
        throw new HttpError(402, "The beta budget is used up, so sponsored defenses are paused.");
      }
      budgetCents = cost;
    }
    return insertEntry(tx, {
      userId: input.userId,
      kind: slot.kind,
      reason: "hold",
      amount: -amount,
      idempotencyKey: input.idempotencyKey,
      source: slot.source,
      purpose: input.kind,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      sponsored: slot.sponsored,
      budgetCents,
      periodId: null,
    });
  });
}

/** Enterprise only: record €2.50 owed and mint one defense credit. No card charge. */
async function maybeOverage(tx: Db, userId: string, holdKey: string): Promise<DrawSlot | null> {
  const assigned = await assignedPlan(tx, userId);
  if (assigned.status !== "active" || assigned.plan.id !== "enterprise" || assigned.plan.overageCents == null) {
    return null;
  }
  const key = `overage:${holdKey}`;
  await tx.run(
    `INSERT INTO billing_overages
      (id, user_id, plan_id, amount_cents, currency, idempotency_key, ref_type, ref_id, created_at)
     VALUES (?, ?, 'enterprise', ?, 'eur', ?, 'hold', ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [newId("ovg"), userId, assigned.plan.overageCents, key, holdKey, new Date().toISOString()],
  );
  await insertEntry(tx, {
    userId,
    kind: "defense",
    reason: "purchase",
    amount: 1,
    idempotencyKey: `overage-credit:${holdKey}`,
    source: "overage",
    purpose: null,
    refType: "overage",
    refId: key,
    sponsored: false,
    budgetCents: null,
    periodId: null,
  });
  return { kind: "defense", source: "overage", sponsored: false };
}

export async function consumeCredit(input: ConsumeCreditInput): Promise<LedgerEntry> {
  return withTx(input.db, async (tx) => {
    await lockWallet(tx, input.userId);
    if (input.holdIdempotencyKey) {
      const hold = await tx.get<LedgerRow>(
        `SELECT * FROM credit_ledger WHERE idempotency_key = ? AND user_id = ?`,
        [input.holdIdempotencyKey, input.userId],
      );
      if (!hold || hold.reason !== "hold") throw new HttpError(404, "Credit hold not found.");
      const settled = await settlement(tx, hold.id);
      if (settled) {
        if (settled.reason === "refund") throw new HttpError(409, "That credit was already refunded.");
        if (settled.idempotency_key === input.idempotencyKey) return mapRow(settled);
        if (settled.reason === "consume") return mapRow(settled);
        throw new HttpError(409, "That credit was already settled.");
      }
      return insertEntry(tx, {
        userId: input.userId,
        kind: hold.kind as LedgerKind,
        reason: "consume",
        amount: 0,
        idempotencyKey: input.idempotencyKey,
        source: (hold.source as CreditSource | null) ?? null,
        purpose: hold.purpose,
        refType: "hold",
        refId: hold.id,
        sponsored: num(hold.sponsored) === 1,
        budgetCents: null,
        periodId: null,
      });
    }
    const amount = requireOneCredit(input.amount);
    const kind = input.kind;
    if (!kind) throw new HttpError(400, "Say whether this spends a defense or a challenge credit.");
    const slot = pickBucket(await loadBuckets(tx, input.userId), kind, amount);
    if (!slot) throw new HttpError(402, "Not enough credits.");
    let budgetCents: number | null = null;
    if (slot.sponsored && kind === "defense") {
      const cost = betaDefenseCents();
      if (!(await reserveBetaBudget(tx, cost))) {
        throw new HttpError(402, "The beta budget is used up, so sponsored defenses are paused.");
      }
      budgetCents = cost;
    }
    return insertEntry(tx, {
      userId: input.userId,
      kind: slot.kind,
      reason: "consume",
      amount: -amount,
      idempotencyKey: input.idempotencyKey,
      source: slot.source,
      purpose: kind,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      sponsored: slot.sponsored,
      budgetCents,
      periodId: null,
    });
  });
}

async function settlement(tx: Db, holdId: string): Promise<LedgerRow | undefined> {
  return tx.get<LedgerRow>(
    `SELECT * FROM credit_ledger WHERE ref_type = 'hold' AND ref_id = ? AND reason IN ('consume', 'refund')
     ORDER BY created_at LIMIT 1`,
    [holdId],
  );
}

/**
 * Return a hold or a consumed credit to the wallet. The credit is never
 * sent back to a card (`REFUND_DESTINATION` is `credit`).
 */
export async function refundCredit(input: RefundCreditInput): Promise<LedgerEntry> {
  return withTx(input.db, async (tx) => {
    await lockWallet(tx, input.userId);
    const entry = await tx.get<LedgerRow>(
      `SELECT * FROM credit_ledger WHERE idempotency_key = ? AND user_id = ?`,
      [input.entryIdempotencyKey, input.userId],
    );
    if (!entry) throw new HttpError(404, "Credit entry not found.");
    const economic = await economicEntry(tx, entry, input.userId);
    const prior = await tx.get<LedgerRow>(
      `SELECT * FROM credit_ledger WHERE ref_type = 'hold' AND ref_id = ? AND reason = 'refund'`,
      [economic.id],
    );
    if (prior) {
      if (prior.idempotency_key === input.idempotencyKey) return mapRow(prior);
      throw new HttpError(409, "That credit was already refunded.");
    }
    const restoring = -num(economic.amount);
    if (restoring <= 0) throw new HttpError(400, "That entry has no credit to return.");
    const budget = economic.budget_cents == null ? null : -num(economic.budget_cents);
    if (budget != null && budget < 0) await releaseBetaBudget(tx, -budget);
    return insertEntry(tx, {
      userId: input.userId,
      kind: economic.kind as LedgerKind,
      reason: "refund",
      amount: restoring,
      idempotencyKey: input.idempotencyKey,
      source: (economic.source as CreditSource | null) ?? null,
      purpose: economic.purpose,
      refType: "hold",
      refId: economic.id,
      sponsored: num(economic.sponsored) === 1,
      budgetCents: budget,
      periodId: null,
    });
  });
}

async function economicEntry(tx: Db, entry: LedgerRow, userId: string): Promise<LedgerRow> {
  if (entry.reason === "hold") return entry;
  if (entry.reason === "consume" && num(entry.amount) < 0) return entry;
  if (entry.reason === "consume" && entry.ref_type === "hold" && entry.ref_id) {
    const hold = await tx.get<LedgerRow>(`SELECT * FROM credit_ledger WHERE id = ? AND user_id = ?`, [
      entry.ref_id,
      userId,
    ]);
    if (hold) return hold;
  }
  throw new HttpError(400, "Only a hold or a consumed credit can be refunded.");
}

/**
 * One beta grant per account, for every sign-in path. The `beta_grants`
 * primary key rejects a second grant. Called from Google sign-in and again
 * on first need (wallet or a defense), so an existing magic-link session
 * is covered the next time it spends.
 */
export async function ensureBetaGrant(userId: string): Promise<{ granted: boolean }> {
  return withTx(undefined, async (tx) => {
    await lockWallet(tx, userId);
    const inserted = await tx.run(
      `INSERT INTO beta_grants (user_id, granted_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING`,
      [userId, new Date().toISOString()],
    );
    if (inserted.changes !== 1) return { granted: false };
    const base = {
      userId,
      reason: "grant" as const,
      source: "beta" as const,
      purpose: null,
      refType: "beta_grant",
      refId: userId,
      sponsored: true,
      budgetCents: null,
      periodId: null,
    };
    const defenses = betaDefenseCredits();
    if (defenses > 0) {
      await insertEntry(tx, {
        ...base,
        kind: "defense",
        amount: defenses,
        idempotencyKey: `beta:${userId}:defense`,
      });
    }
    await insertEntry(tx, {
      ...base,
      kind: "challenge",
      amount: BETA_GRANT.challenge,
      idempotencyKey: `beta:${userId}:challenge`,
    });
    await insertEntry(tx, {
      ...base,
      kind: "learn_slot",
      amount: BETA_GRANT.learnSlots,
      idempotencyKey: `beta:${userId}:learn_slot`,
    });
    return { granted: true };
  });
}

/** Google sign-in calls this. It is the same once-per-account grant as `ensureBetaGrant`. */
export async function grantBetaIfFirstGoogleSignIn(userId: string): Promise<{ granted: boolean }> {
  return ensureBetaGrant(userId);
}

export async function getUserPlan(userId: string): Promise<AssignedPlan> {
  return assignedPlan(await getDb(), userId);
}

/**
 * Map a stored plan id to the cost-cap tier. #42 can call this with
 * `getUserPlan(userId).plan.id`, or call `costTierForUser` with the user id.
 * Unknown ids are consumer. Admins are not rewritten here. The cap is not enforced.
 */
export function costTierForUserPlan(planId: string): CostCapTier {
  return costTierForPlan(planId);
}

/** The tier #42 should use for this account: the assigned plan's `costTier`. */
export async function costTierForUser(userId: string): Promise<CostCapTier> {
  return (await getUserPlan(userId)).costTier;
}

export async function renewPlan(input: {
  userId: string;
  planId: PlanId;
  interval: BillingInterval;
  periodId: string;
}): Promise<void> {
  const plan = getPlan(input.planId);
  const periods = periodsForInterval(input.interval);
  await withTx(undefined, async (tx) => {
    await lockWallet(tx, input.userId);
    const current = await tx.get<{ period_id: string | null }>(
      `SELECT period_id FROM user_plans WHERE user_id = ?`,
      [input.userId],
    );
    if (current?.period_id === input.periodId) return;
    if (!plan.challengesRollOver) {
      await expireSource(tx, input.userId, "challenge", input.periodId);
    }
    if (!plan.defensesRollOver) {
      await expireSource(tx, input.userId, "defense", input.periodId);
    }
    const defenses = plan.defensesPerPeriod * periods;
    const challenges = plan.challengesPerPeriod * periods;
    if (defenses > 0) {
      await insertEntry(tx, renewalEntry(input, "defense", defenses));
    }
    if (challenges > 0) {
      await insertEntry(tx, renewalEntry(input, "challenge", challenges));
    }
    if (plan.learnSlots != null) {
      const have = await sumKind(tx, input.userId, "learn_slot");
      const topUp = plan.learnSlots - have;
      if (topUp > 0) await insertEntry(tx, renewalEntry(input, "learn_slot", topUp));
    }
    const now = new Date().toISOString();
    await tx.run(
      `INSERT INTO user_plans (user_id, plan_id, interval, status, period_id, current_period_end, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         plan_id = excluded.plan_id,
         interval = excluded.interval,
         status = 'active',
         period_id = excluded.period_id,
         current_period_end = excluded.current_period_end,
         updated_at = excluded.updated_at`,
      [input.userId, input.planId, input.interval, input.periodId, periodEnd(input.interval), now],
    );
  });
}

function renewalEntry(
  input: { userId: string; periodId: string },
  kind: LedgerKind,
  amount: number,
): Insert {
  return {
    userId: input.userId,
    kind,
    reason: "subscription_renewal",
    amount,
    idempotencyKey: `renew:${input.periodId}:${kind}`,
    source: "subscription",
    purpose: null,
    refType: "renewal",
    refId: input.periodId,
    sponsored: false,
    budgetCents: null,
    periodId: input.periodId,
  };
}

async function expireSource(tx: Db, userId: string, kind: "defense" | "challenge", periodId: string): Promise<void> {
  const have = await sumBucket(tx, userId, kind, "subscription");
  if (have <= 0) return;
  await insertEntry(tx, {
    userId,
    kind,
    reason: "expire",
    amount: -have,
    idempotencyKey: `expire:${periodId}:${kind}`,
    source: "subscription",
    purpose: null,
    refType: "renewal",
    refId: periodId,
    sponsored: false,
    budgetCents: null,
    periodId,
  });
}

function periodEnd(interval: BillingInterval): string {
  const date = new Date();
  switch (interval) {
    case "month":
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
    case "year":
      date.setUTCFullYear(date.getUTCFullYear() + 1);
      break;
    default: {
      const unknown: never = interval;
      return unknown;
    }
  }
  return date.toISOString();
}

/**
 * Reject a creator claiming their own challenge, including the same card
 * fingerprint once one is stored. No payment network is contacted.
 */
export async function assertNotSelfClaim(input: {
  creatorUserId: string;
  claimerUserId: string;
}): Promise<void> {
  if (!input.creatorUserId || !input.claimerUserId) {
    throw new HttpError(400, "Challenge claim is missing an account.");
  }
  if (input.creatorUserId === input.claimerUserId) {
    throw new HttpError(403, "You created this challenge. Send the link to someone else.");
  }
  const db = await getDb();
  const rows = await db.all<{ user_id: string; card_fingerprint: string | null }>(
    `SELECT user_id, card_fingerprint FROM billing_profiles
     WHERE user_id IN (?, ?) AND card_fingerprint IS NOT NULL`,
    [input.creatorUserId, input.claimerUserId],
  );
  const fingerprints = rows.map((row) => row.card_fingerprint).filter((fp): fp is string => !!fp);
  if (fingerprints.length === 2 && fingerprints[0] === fingerprints[1]) {
    throw new HttpError(403, "You can't claim a challenge paid with your own card.");
  }
}

export async function setCardFingerprint(userId: string, fingerprint: string): Promise<void> {
  const value = fingerprint.trim().slice(0, 128);
  if (!value) throw new HttpError(400, "Card fingerprint is empty.");
  const db = await getDb();
  await db.run(
    `INSERT INTO billing_profiles (user_id, card_fingerprint, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       card_fingerprint = excluded.card_fingerprint,
       updated_at = excluded.updated_at`,
    [userId, value, new Date().toISOString()],
  );
}

/**
 * Record that `defenderUserId` is defending a challenge from someone else.
 * Completion grants the onward credit. Nothing here reads a share or post flag.
 */
export async function linkChallengedDefense(input: {
  challengeId: string;
  challengerUserId: string;
  defenderUserId: string;
  sessionId?: string;
  requestId?: string;
}): Promise<void> {
  await assertNotSelfClaim({
    creatorUserId: input.challengerUserId,
    claimerUserId: input.defenderUserId,
  });
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO credit_challenge_claims
      (challenge_id, challenger_user_id, defender_user_id, session_id, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (challenge_id) DO NOTHING`,
    [
      input.challengeId,
      input.challengerUserId,
      input.defenderUserId,
      input.sessionId ?? null,
      input.requestId ?? null,
      now,
    ],
  );
  if (input.sessionId || input.requestId) {
    await db.run(
      `UPDATE credit_challenge_claims
       SET session_id = COALESCE(?, session_id), request_id = COALESCE(?, request_id)
       WHERE challenge_id = ? AND challenger_user_id = ? AND defender_user_id = ?`,
      [
        input.sessionId ?? null,
        input.requestId ?? null,
        input.challengeId,
        input.challengerUserId,
        input.defenderUserId,
      ],
    );
  }
}

/** How long a hold may stay unattached while the first question is phrased. */
const FRESH_UNATTACHED_HOLD_MS = 2 * 60 * 1000;

const REPLACED_START = "This start was replaced by a newer one.";

/**
 * Open defense holds for this account that a new start may take back.
 * An unattached hold is released only after it has sat for two minutes, so a
 * double-click cannot refund the hold the other request is about to attach.
 * A hold already attached to an in-progress defense this account started is
 * released immediately. Grading and finished defenses keep their credit.
 * A challenge-defense reservation is a zero-credit budget row. It is not a
 * hold this function can return, and a newer start still needs it.
 */
async function releaseUnfinishedDefenseHolds(tx: Db, userId: string): Promise<void> {
  const staleBefore = new Date(Date.now() - FRESH_UNATTACHED_HOLD_MS).toISOString();
  const rows = await tx.all<{ idempotency_key: string; session_id: string | null }>(
    `SELECT l.idempotency_key,
            (
              SELECT h.session_id FROM defense_holds h
              JOIN sessions s ON s.id = h.session_id
              WHERE h.hold_idempotency_key = l.idempotency_key
                AND h.user_id = l.user_id
                AND s.user_id = l.user_id
                AND s.mode = 'defend'
                AND s.status = 'in_progress'
              LIMIT 1
            ) AS session_id
     FROM credit_ledger l
     WHERE l.user_id = ?
       AND l.reason = 'hold'
       AND l.purpose = 'defense'
       AND l.amount < 0
       AND COALESCE(l.ref_type, '') <> 'challenge_defense'
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger c
         WHERE c.ref_type = 'hold' AND c.ref_id = l.id AND c.reason IN ('consume', 'refund')
       )
       AND (
         (
           NOT EXISTS (
             SELECT 1 FROM defense_holds h
             WHERE h.hold_idempotency_key = l.idempotency_key AND h.user_id = l.user_id
           )
           AND l.created_at <= ?
         )
         OR EXISTS (
           SELECT 1 FROM defense_holds h
           JOIN sessions s ON s.id = h.session_id
           WHERE h.hold_idempotency_key = l.idempotency_key
             AND h.user_id = l.user_id
             AND s.user_id = l.user_id
             AND s.mode = 'defend'
             AND s.status = 'in_progress'
         )
       )`,
    [userId, staleBefore],
  );
  for (const row of rows) {
    await refundCredit({
      userId,
      entryIdempotencyKey: row.idempotency_key,
      idempotencyKey: `refund:${row.idempotency_key}`,
      db: tx,
    });
    if (!row.session_id) continue;
    await tx.run(
      `UPDATE sessions SET status = 'abandoned'
       WHERE id = ? AND user_id = ? AND status = 'in_progress' AND mode = 'defend'`,
      [row.session_id, userId],
    );
    await tx.run(`DELETE FROM defense_holds WHERE session_id = ? AND user_id = ?`, [row.session_id, userId]);
  }
}

/**
 * Hold one defense credit. Applies the beta grant first, for whichever way
 * the user signed in. In this same transaction, refund an earlier hold that
 * is already attached to an in-progress defense, or an unattached hold older
 * than two minutes. A fresh unattached hold from a concurrent start stays.
 * The grant is the whole free allowance. The global budget can still refuse
 * a sponsored defense before that allowance is gone.
 */
export async function beginDefenseCredit(
  userId: string,
): Promise<{ idempotencyKey: string; sponsored: boolean }> {
  const db = await getDb();
  const existing = await db.get<{ email: string }>(`SELECT email FROM users WHERE id = ?`, [userId]);
  if (existing && isDemoPrincipalEmail(existing.email)) {
    throw new HttpError(403, "A sample demo does not spend account credits.");
  }
  await ensureBetaGrant(userId);
  const idempotencyKey = `defense-hold:${userId}:${newId("hold")}`;
  const entry = await withTx(undefined, async (tx) => {
    await lockWallet(tx, userId);
    await releaseUnfinishedDefenseHolds(tx, userId);
    return holdCredit({
      userId,
      kind: "defense",
      amount: 1,
      idempotencyKey,
      refType: "defense_start",
      refId: idempotencyKey,
      db: tx,
    });
  });
  return { idempotencyKey: entry.idempotencyKey, sponsored: entry.sponsored };
}

/**
 * Link a hold to the session that is about to ask question 1.
 * The claim is one conditional UPDATE under the wallet lock: it matches
 * only while that hold is still open. A refunded or settled hold abandons
 * this session instead of letting it finish on a credit that was returned.
 */
export async function attachDefenseCredit(
  userId: string,
  idempotencyKey: string,
  sessionId: string,
): Promise<void> {
  let refused: "missing" | "replaced" | null = null;
  await withTx(undefined, async (tx) => {
    await lockWallet(tx, userId);
    const hold = await tx.get<LedgerRow>(
      `SELECT * FROM credit_ledger WHERE idempotency_key = ? AND user_id = ?`,
      [idempotencyKey, userId],
    );
    if (!hold || hold.reason !== "hold") {
      await abandonReplacedDefense(tx, userId, sessionId);
      refused = "missing";
      return;
    }
    const open = await tx.run(
      `UPDATE credit_wallets
       SET lock_nonce = lock_nonce + 1
       WHERE user_id = ?
         AND EXISTS (
           SELECT 1 FROM credit_ledger h
           WHERE h.id = ?
             AND h.user_id = credit_wallets.user_id
             AND h.reason = 'hold'
             AND NOT EXISTS (
               SELECT 1 FROM credit_ledger settled
               WHERE settled.ref_type = 'hold'
                 AND settled.ref_id = h.id
                 AND settled.reason IN ('consume', 'refund')
             )
         )`,
      [userId, hold.id],
    );
    if (open.changes !== 1) {
      await abandonReplacedDefense(tx, userId, sessionId);
      refused = "replaced";
      return;
    }
    const bySession = await tx.get<{ hold_idempotency_key: string }>(
      `SELECT hold_idempotency_key FROM defense_holds WHERE session_id = ?`,
      [sessionId],
    );
    const byHold = await tx.get<{ session_id: string }>(
      `SELECT session_id FROM defense_holds WHERE hold_idempotency_key = ?`,
      [idempotencyKey],
    );
    const sameLink =
      bySession?.hold_idempotency_key === idempotencyKey &&
      (byHold == null || byHold.session_id === sessionId);
    if (bySession || byHold) {
      if (!sameLink) {
        await abandonReplacedDefense(tx, userId, sessionId);
        refused = "replaced";
      } else if (num(hold.sponsored) === 1) {
        await tx.run(`UPDATE sessions SET sponsored = 1 WHERE id = ? AND user_id = ?`, [sessionId, userId]);
      }
      return;
    }
    try {
      await tx.run(
        `INSERT INTO defense_holds (session_id, user_id, hold_idempotency_key, created_at)
         VALUES (?, ?, ?, ?)`,
        [sessionId, userId, idempotencyKey, new Date().toISOString()],
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await abandonReplacedDefense(tx, userId, sessionId);
      refused = "replaced";
      return;
    }
    if (num(hold.sponsored) === 1) {
      await tx.run(`UPDATE sessions SET sponsored = 1 WHERE id = ? AND user_id = ?`, [sessionId, userId]);
    }
  });
  if (refused === "missing") throw new HttpError(409, "Defense credit hold not found.");
  if (refused === "replaced") throw new HttpError(409, REPLACED_START);
}

async function abandonReplacedDefense(tx: Db, userId: string, sessionId: string): Promise<void> {
  await tx.run(
    `UPDATE sessions SET status = 'abandoned'
     WHERE id = ? AND user_id = ? AND status = 'in_progress' AND mode = 'defend'`,
    [sessionId, userId],
  );
  await tx.run(`DELETE FROM defense_holds WHERE session_id = ? AND user_id = ?`, [sessionId, userId]);
}

/** Return the held credit and drop an in-progress defense that never reached grading. */
export async function abortDefenseCredit(
  userId: string,
  idempotencyKey: string,
  sessionId?: string | null,
): Promise<void> {
  await withTx(undefined, async (tx) => {
    await lockWallet(tx, userId);
    const hold = await tx.get<LedgerRow>(
      `SELECT * FROM credit_ledger WHERE idempotency_key = ? AND user_id = ?`,
      [idempotencyKey, userId],
    );
    if (hold?.reason === "hold") {
      const settled = await settlement(tx, hold.id);
      if (!settled) {
        await refundCredit({
          userId,
          entryIdempotencyKey: idempotencyKey,
          idempotencyKey: `refund:${idempotencyKey}`,
          db: tx,
        });
      }
    }
    if (!sessionId) return;
    await abandonReplacedDefense(tx, userId, sessionId);
  });
}

/**
 * Consume the defense hold, if there is one, and grant the onward challenge
 * credit. An already-refunded hold is not charged again: the receipt is
 * already signed, so this returns instead of raising.
 */
export async function finishDefenseCredit(userId: string, sessionId: string): Promise<void> {
  const db = await getDb();
  const link = await db.get<{ hold_idempotency_key: string }>(
    `SELECT hold_idempotency_key FROM defense_holds WHERE session_id = ? AND user_id = ?`,
    [sessionId, userId],
  );
  if (link) {
    try {
      await consumeCredit({
        userId,
        holdIdempotencyKey: link.hold_idempotency_key,
        idempotencyKey: `consume:${link.hold_idempotency_key}`,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && e.message === "That credit was already refunded.") {
        console.error(`[credits] defense ${sessionId} finished after its hold was refunded; no charge`);
      } else {
        throw e;
      }
    }
  }
  await grantOnwardForSession(userId, sessionId);
}

async function grantOnwardForSession(userId: string, sessionId: string): Promise<void> {
  const db = await getDb();
  const claim = await db.get<{
    challenge_id: string;
    challenger_user_id: string;
    defender_user_id: string;
  }>(
    `SELECT challenge_id, challenger_user_id, defender_user_id
     FROM credit_challenge_claims
     WHERE defender_user_id = ?
       AND (session_id = ? OR request_id = (SELECT request_id FROM sessions WHERE id = ?))`,
    [userId, sessionId, sessionId],
  );
  if (!claim) return;
  if (claim.challenger_user_id === claim.defender_user_id) return;
  if (claim.defender_user_id !== userId) return;
  await grantCredits({
    userId,
    kind: "challenge",
    amount: ONWARD_CHALLENGE_CREDITS,
    reason: "grant",
    source: "onward",
    sponsored: true,
    idempotencyKey: `onward:${claim.challenge_id}`,
    refType: "challenge",
    refId: claim.challenge_id,
  });
}

export async function refundStaleDefenseHolds(): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const rows = await db.all<{ idempotency_key: string; user_id: string; session_id: string }>(
    `SELECT l.idempotency_key, l.user_id, h.session_id
     FROM credit_ledger l
     JOIN defense_holds h ON h.hold_idempotency_key = l.idempotency_key
     JOIN sessions s ON s.id = h.session_id
     WHERE l.reason = 'hold'
       AND s.status = 'in_progress'
       AND s.purge_after < ?
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger c
         WHERE c.ref_type = 'hold' AND c.ref_id = l.id AND c.reason IN ('consume', 'refund')
       )`,
    [now],
  );
  for (const row of rows) {
    await abortDefenseCredit(row.user_id, row.idempotency_key, row.session_id);
  }
  return rows.length;
}

export async function learnSlotLimit(userId: string, db?: Db): Promise<number | null> {
  const conn = db ?? (await getDb());
  const assigned = await assignedPlan(conn, userId);
  const ledger = await sumKind(conn, userId, "learn_slot");
  if (
    assigned.status === "active" &&
    assigned.plan.learnSlots == null &&
    (assigned.plan.id === "team" || assigned.plan.id === "enterprise")
  ) {
    return null;
  }
  if (assigned.status === "active" && assigned.plan.learnSlots != null) {
    return Math.max(assigned.plan.learnSlots, ledger);
  }
  if (ledger > 0) return ledger;
  return null;
}

/**
 * Projects that still hold a Learn slot. Closed, purged, and past
 * `purge_after` do not. `purge_after` is checked on read, so a late purge
 * job does not leave the slot taken.
 */
const OPEN_LEARN_COUNT_SQL = `SELECT COUNT(*) FROM defense_requests r
  WHERE r.creator_user_id = ? AND r.learn_closed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM deliverables d
      WHERE d.request_id = r.id
        AND d.purged_at IS NULL
        AND d.purge_after >= ?
    )`;

export async function countActiveLearnProjects(userId: string, db?: Db): Promise<number> {
  const conn = db ?? (await getDb());
  const row = await conn.get<{ n: number | string }>(`SELECT (${OPEN_LEARN_COUNT_SQL}) AS n`, [
    userId,
    new Date().toISOString(),
  ]);
  return num(row?.n);
}

/**
 * While billing is off, Learn uploads are not capped. The beta grant's 3
 * slots would otherwise count every file the account ever keeps open.
 * When billing is on, the wallet counter is set to the number of projects
 * that are still open, which can fall, and then one slot is claimed with a
 * conditional UPDATE. Pass `db` from the transaction that inserts the project
 * so the counter and the row commit together.
 */
export async function assertLearnSlotAvailable(userId: string, db?: Db): Promise<void> {
  if (!billingEnabled()) return;
  const claim = async (tx: Db) => {
    const limit = await learnSlotLimit(userId, tx);
    if (limit == null) return;
    await lockWallet(tx, userId);
    const now = new Date().toISOString();
    await tx.run(
      `UPDATE credit_wallets
       SET learn_open = (${OPEN_LEARN_COUNT_SQL})
       WHERE user_id = ?`,
      [userId, now, userId],
    );
    const claimed = await tx.run(
      `UPDATE credit_wallets
       SET learn_open = learn_open + 1
       WHERE user_id = ? AND learn_open < ?`,
      [userId, limit],
    );
    if (claimed.changes !== 1) {
      throw new HttpError(402, "Learn project slots are full. Close one to open another.");
    }
  };
  if (db) {
    await claim(db);
    return;
  }
  await withTx(undefined, claim);
}

/** Free a Learn slot. Does not change document retention or delete the receipt. */
export async function closeLearnProject(userId: string, token: string): Promise<void> {
  await withTx(undefined, async (tx) => {
    const closed = await tx.run(
      `UPDATE defense_requests SET learn_closed_at = ?
       WHERE token = ? AND creator_user_id = ? AND learn_closed_at IS NULL`,
      [new Date().toISOString(), token, userId],
    );
    if (closed.changes !== 1) throw new HttpError(404, "Project not found");
    await tx.run(
      `UPDATE credit_wallets
       SET learn_open = CASE WHEN learn_open > 0 THEN learn_open - 1 ELSE 0 END
       WHERE user_id = ?`,
      [userId],
    );
  });
}

export function ledgerLabel(entry: {
  reason: LedgerReason;
  kind: string;
  source: string | null;
  sponsored: boolean;
  purpose: string | null;
}): string {
  const sponsored = entry.sponsored ? " · Sponsored by DefendIT" : "";
  switch (entry.reason) {
    case "grant":
      if (entry.source === "beta") return `Beta grant${sponsored}`;
      if (entry.source === "onward") return `Onward challenge${sponsored}`;
      return `Grant${sponsored}`;
    case "purchase":
      if (entry.source === "overage") return "Enterprise overage";
      if (entry.source === "pack") return "Credit pack";
      return "Purchase";
    case "subscription_renewal":
      return "Subscription renewal";
    case "hold":
      return `Hold for ${entry.purpose ?? entry.kind}${sponsored}`;
    case "consume":
      return `Used for ${entry.purpose ?? entry.kind}${sponsored}`;
    case "refund":
      return `Refunded to credit${sponsored}`;
    case "expire":
      return "Expired at renewal";
    case "admin_adjust":
      return "Adjustment";
    default: {
      const unknown: never = entry.reason;
      return unknown;
    }
  }
}

export interface WalletView {
  balance: CreditBalance;
  plan: { id: PlanId; name: string; costTier: CostCapTier; status: AssignedPlan["status"] };
  learn: { active: number; limit: number | null };
  prices: {
    defense: string;
    challenge: string;
    pack3: string;
    pack8: string;
    subscriptionMonth: string;
    note: string;
  };
  history: { id: string; at: string; label: string; amount: number; kind: string; sponsored: boolean }[];
}

export async function walletView(userId: string): Promise<WalletView> {
  await ensureBetaGrant(userId);
  const [balance, plan, active, limit, history] = await Promise.all([
    getBalance(userId),
    getUserPlan(userId),
    countActiveLearnProjects(userId),
    learnSlotLimit(userId),
    recentLedger(userId),
  ]);
  const sub = getPlan("subscription");
  return {
    balance,
    plan: { id: plan.plan.id, name: plan.plan.name, costTier: plan.costTier, status: plan.status },
    learn: { active, limit },
    prices: {
      defense: formatEur(PAYG_CENTS.defense),
      challenge: formatEur(PAYG_CENTS.challenge),
      pack3: formatEur(PACKS.pack3.priceCents),
      pack8: formatEur(PACKS.pack8.priceCents),
      subscriptionMonth: formatEur(sub.priceCents.month ?? 0),
      note: "Prices include VAT.",
    },
    history,
  };
}

async function recentLedger(userId: string) {
  const db = await getDb();
  const rows = await db.all<LedgerRow>(
    `SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
    [userId],
  );
  return rows.map((row) => {
    const entry = mapRow(row);
    return {
      id: entry.id,
      at: entry.createdAt,
      label: ledgerLabel(entry),
      amount: entry.amount,
      kind: entry.kind,
      sponsored: entry.sponsored,
    };
  });
}
