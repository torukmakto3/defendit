import { AsyncLocalStorage } from "node:async_hooks";
import {
  budgetUsdForTier,
  budgetUsdForUser,
  callReserveUsd,
  getCostTier,
  parseCostTier,
  type CostTier,
} from "../cost";
import { getDb, type Db } from "../db";
import { newId } from "../ids";
import type { LlmUsage } from "./types";

/**
 * Token and dollar accounting for one defense.
 *
 * Liquid's OpenAI-compatible response carries the settled charge on
 * `exchange.charge.total_usd` and metered tokens on `exchange.usage`.
 * Other hosts use `usage.prompt_tokens` / `usage.completion_tokens` and,
 * when they price the call, `usage.cost`. A missing cost is estimated from
 * the token counts. A missing token count is estimated from the text
 * (about 4 characters per token).
 *
 * Calls are stored while a scope is active (a defense request and, once it
 * exists, a session). The defend session's stored total is every call on
 * that defense. Before each call the scope inserts a `budget_holds` row. The
 * insert lands only when spent calls, reported voice dollars, and holds newer
 * than two minutes, plus this call, still fit. A hold older than that is
 * ignored, so a killed request cannot block the defense. Two requests on the
 * same session cannot both pass that insert. Optional
 * work is skipped when the reservation does not land. Required work moves to
 * the cheap model, and a defense with no grade yet still gets one grader so
 * it can finish. Until the session row exists, the same check is in-memory
 * for calls that share this scope.
 */

const DEFAULT_BUDGET_USD = 3;
const DEFAULT_INPUT_PER_MTOK = 0.15;
const DEFAULT_OUTPUT_PER_MTOK = 0.6;

interface Scope {
  sessionId?: string;
  requestId?: string;
  tier: CostTier;
  budgetUsd: number;
  persistedUsd: number;
  voiceUsd: number;
  persistedGrades: number;
  persistedLearnTurns: number;
  pending: PendingCall[];
  capped: boolean;
  forceMinimum: boolean;
  /** Session row this scope reserves against, once one exists. */
  reserveSessionId?: string;
}

interface PendingCall {
  id: string;
  purpose: string | null;
  provider: string;
  modelId: string;
  requestedModelId: string;
  usage: LlmUsage;
  createdAt: string;
  /** True until the provider returns. Flushed rows are real calls only. */
  reserved: boolean;
  /** Dollars added to budget_holds. 0 when no session row existed yet. */
  heldUsd: number;
  heldGrades: number;
  heldSessionId: string | null;
  /** budget_holds.id, set once the row is inserted. */
  holdId: string | null;
}

export interface LlmScopeIds {
  sessionId?: string;
  requestId?: string;
  user?: { email: string } | null;
}

export interface BudgetBegin {
  allow: boolean;
  reservationId: string | null;
  /** Call the cheap model instead of the one the caller asked for. */
  useCheap: boolean;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Thrown when a call is not sent because the defense cap has no room for it. */
export class LlmBudgetError extends Error {
  readonly purpose: string;
  constructor(purpose: string) {
    super(`Skipped ${purpose}: defense cost cap`);
    this.name = "LlmBudgetError";
    this.purpose = purpose;
  }
}

/** Legacy single cap: `SESSION_BUDGET_USD`, or $3 when that variable is unset. */
export function sessionBudgetUsd(): number {
  return readNonNegative(process.env.SESSION_BUDGET_USD, DEFAULT_BUDGET_USD);
}

/** USD per million tokens, used only when the provider did not return a cost. */
export function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  const input = readNonNegative(process.env.LLM_PRICE_INPUT_PER_MTOK, DEFAULT_INPUT_PER_MTOK);
  const output = readNonNegative(process.env.LLM_PRICE_OUTPUT_PER_MTOK, DEFAULT_OUTPUT_PER_MTOK);
  return (promptTokens * input + completionTokens * output) / 1_000_000;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * What the next call is assumed to cost before it is sent.
 * The reserve floor is the per-call cap; token prices raise it for a long prompt.
 */
export function estimateUpcomingCallUsd(promptText: string, kind: "standard" | "cheap"): number {
  const configured = readUsd(process.env.LLM_RESERVE_OUTPUT_TOKENS);
  const outputTokens = configured ?? (kind === "cheap" ? 256 : 512);
  const fromTokens = estimateCostUsd(estimateTokens(promptText), outputTokens);
  return Math.max(fromTokens, callReserveUsd(kind));
}

export function usageFromProviderBody(
  body: unknown,
  fallback: { promptText: string; completionText: string },
): LlmUsage {
  const root = record(body);
  const usage = record(root?.usage);
  const exchange = record(root?.exchange);
  const charge = record(exchange?.charge);
  const metered = record(exchange?.usage);
  const details = record(usage?.cost_details);

  const meteredIn = num(metered?.tokens_in);
  const meteredOut = num(metered?.tokens_out);
  let promptTokens: number;
  let completionTokens: number;
  if (meteredIn !== null || meteredOut !== null) {
    // tokens_out is the generated answer. reasoning_tokens are billed as output
    // and are reported beside it, so they count toward completion.
    promptTokens = whole(meteredIn ?? 0);
    completionTokens = whole((meteredOut ?? 0) + (num(metered?.reasoning_tokens) ?? 0));
  } else {
    const prompt = num(usage?.prompt_tokens, usage?.input_tokens);
    const completion = num(usage?.completion_tokens, usage?.output_tokens);
    if (prompt === null && completion === null) {
      promptTokens = estimateTokens(fallback.promptText);
      completionTokens = estimateTokens(fallback.completionText);
    } else {
      promptTokens = whole(prompt ?? estimateTokens(fallback.promptText));
      completionTokens = whole(completion ?? estimateTokens(fallback.completionText));
    }
  }

  const providerCost = num(
    charge?.total_usd,
    usage?.cost,
    usage?.cost_usd,
    usage?.total_cost,
    details?.upstream_inference_cost,
    root?.cost,
    root?.cost_usd,
  );
  if (providerCost !== null) {
    return { promptTokens, completionTokens, costUsd: providerCost, costSource: "provider" };
  }
  return {
    promptTokens,
    completionTokens,
    costUsd: estimateCostUsd(promptTokens, completionTokens),
    costSource: "estimated",
  };
}

export function withLlmScope<T>(ids: LlmScopeIds, fn: () => Promise<T>): Promise<T> {
  return openScope(ids, fn);
}

async function openScope<T>(ids: LlmScopeIds, fn: () => Promise<T>): Promise<T> {
  const loaded = await loadScope(ids);
  return scopes.run(loaded, async () => {
    try {
      return await fn();
    } finally {
      await flushLlmScope({});
    }
  });
}

/**
 * Write every settled call queued in this scope. One transaction, one total
 * recompute. Grading used to await this per grader, on the council's critical path.
 */
export async function flushLlmScope(ids: { sessionId?: string; requestId?: string }): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  if (ids.sessionId) scope.sessionId = ids.sessionId;
  if (ids.requestId) scope.requestId = ids.requestId;
  const queued = scope.pending.splice(0);
  const pending = queued.filter((call) => !call.reserved);
  const abandoned = queued.filter((call) => call.reserved && call.heldSessionId);
  const capped = scope.capped;
  if (pending.length === 0) {
    if (abandoned.length > 0) await releaseHolds(await getDb(), abandoned);
    if (capped) await markCapped(scope);
    return;
  }
  if (!scope.sessionId && !scope.requestId) {
    scope.pending.unshift(...pending);
    if (abandoned.length > 0) await releaseHolds(await getDb(), abandoned);
    return;
  }
  await persistAll(pending, abandoned, capped);
}

/**
 * Reserve room for a call that is about to be sent.
 * Inside one scope the in-memory hold is taken before the first await, so
 * parallel graders in this request see each other. The session row then
 * confirms it with a conditional update, which is what stops a second
 * request on the same session. Outside a scope there is nothing to cap.
 */
export async function beginBudget(input: {
  purpose?: string;
  modelId: string;
  promptText: string;
}): Promise<BudgetBegin> {
  const scope = scopes.getStore();
  if (!scope) return { allow: true, reservationId: null, useCheap: false };
  const purpose = (input.purpose || "model").slice(0, 80);
  const standard = estimateUpcomingCallUsd(input.promptText, "standard");
  const cheap = estimateUpcomingCallUsd(input.promptText, "cheap");
  const local = budgetInMemory(scope, purpose, input.modelId, standard, cheap);
  const sessionId = await lookupSession(scope);
  if (!sessionId || !local.allow || !local.reservationId) return local;

  const call = scope.pending.find((row) => row.id === local.reservationId);
  if (!call) return local;
  const roomBefore = committedUsd(scope) - call.usage.costUsd;
  const overCap = call.usage.costUsd > scope.budgetUsd - roomBefore + 1e-9;
  const claimed = await claimReserve(
    sessionId,
    call.id,
    call.usage.costUsd,
    purpose === "grade" ? 1 : 0,
    overCap ? 1 : 0,
    scope.budgetUsd,
  );
  if (claimed) {
    call.heldUsd = call.usage.costUsd;
    call.heldGrades = purpose === "grade" ? 1 : 0;
    call.heldSessionId = sessionId;
    call.holdId = call.id;
    return local;
  }

  dropPending(scope, local.reservationId);
  // The in-memory choice was already the one over-cap grade, and the database refused it.
  if (local.useCheap && overCap) {
    noteCap(scope, purpose, "skip", committedUsd(scope));
    return { allow: false, reservationId: null, useCheap: false };
  }
  if (!local.useCheap && isOptional(scope, purpose, input.modelId)) {
    noteCap(scope, purpose, "skip", committedUsd(scope));
    return { allow: false, reservationId: null, useCheap: false };
  }
  if (!local.useCheap) {
    const cheapHold = await holdOnSession(scope, sessionId, purpose, input.modelId, cheap, false, "cheap");
    if (cheapHold) return cheapHold;
  }
  // Cheap can fit in this process and still lose the row to another request.
  // The first grade still goes through once, over the cap.
  if (purpose === "grade" && !hasGrade(scope)) {
    const minimum = await holdOnSession(scope, sessionId, purpose, input.modelId, cheap, true, "minimum");
    if (minimum) return minimum;
  }
  noteCap(scope, purpose, "skip", committedUsd(scope));
  return { allow: false, reservationId: null, useCheap: false };
}

/** Replace a reservation with the provider's actual usage. */
export function settleBudget(
  reservationId: string,
  input: { provider: string; modelId: string; usage: LlmUsage },
): void {
  const scope = scopes.getStore();
  if (!scope) return;
  const row = scope.pending.find((call) => call.id === reservationId);
  if (!row) return;
  row.provider = input.provider.slice(0, 40);
  row.modelId = input.modelId.slice(0, 120);
  row.usage = input.usage;
  row.reserved = false;
}

/** Drop a reservation when the call fails before it is billed. */
export async function releaseBudget(reservationId: string | null): Promise<void> {
  if (!reservationId) return;
  const scope = scopes.getStore();
  if (!scope) return;
  const index = scope.pending.findIndex((call) => call.id === reservationId);
  if (index < 0) return;
  const [call] = scope.pending.splice(index, 1);
  if (call?.heldSessionId) await releaseHolds(await getDb(), [call]);
}

/** Let the next grade call through on the cheap model even when it is over the cap. */
export function forceNextGrade(): void {
  const scope = scopes.getStore();
  if (scope) scope.forceMinimum = true;
}

export function scopeWasCapped(): boolean {
  return Boolean(scopes.getStore()?.capped);
}

/**
 * Queue a call that already happened outside the gate. Prefer `beginBudget`
 * so the spend is reserved first. This does not touch the database.
 */
export async function recordLlmCall(input: {
  purpose?: string;
  provider: string;
  modelId: string;
  usage: LlmUsage;
}): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.pending.push({
    id: newId("llm"),
    purpose: input.purpose?.slice(0, 80) || null,
    provider: input.provider.slice(0, 40),
    modelId: input.modelId.slice(0, 120),
    requestedModelId: input.modelId.slice(0, 120),
    usage: input.usage,
    createdAt: new Date().toISOString(),
    reserved: false,
    heldUsd: 0,
    heldGrades: 0,
    heldSessionId: null,
    holdId: null,
  });
}

/** Recompute stored totals after a session row is inserted. */
export async function refreshRequestUsage(requestId: string): Promise<void> {
  try {
    await recompute(await getDb(), requestId, sessionBudgetUsd());
  } catch (e) {
    console.error("[usage] failed to refresh session totals", e instanceof Error ? e.message : e);
  }
}

/** Spent LLM dollars plus reported voice dollars, and the cap stored on the session. */
export async function defenseCapState(
  requestId: string,
  sessionId: string,
): Promise<{ spentUsd: number; budgetUsd: number; tier: CostTier }> {
  const db = await getDb();
  const spend = await db.get<{ cost: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_calls WHERE request_id = ?`,
    [requestId],
  );
  const session = await db.get<{
    budget_usd: number | null;
    cost_tier: string | null;
    voice_cost_usd: number | null;
  }>(`SELECT budget_usd, cost_tier, voice_cost_usd FROM sessions WHERE id = ?`, [sessionId]);
  const tier = parseCostTier(session?.cost_tier);
  const budget =
    session?.budget_usd != null && Number.isFinite(Number(session.budget_usd))
      ? Number(session.budget_usd)
      : budgetUsdForTier(tier);
  return {
    spentUsd: Number(spend?.cost ?? 0) + Number(session?.voice_cost_usd ?? 0),
    budgetUsd: budget,
    tier,
  };
}

export async function markDefenseCapped(requestId: string, sessionId: string, purpose: string): Promise<void> {
  console.info(
    JSON.stringify({
      event: "budget_capped",
      action: "skip",
      purpose,
      requestId,
      sessionId,
    }),
  );
  try {
    const db = await getDb();
    await db.run(
      `UPDATE sessions SET budget_capped = 1 WHERE id = ? OR (request_id = ? AND mode = 'defend')`,
      [sessionId, requestId],
    );
  } catch (e) {
    console.error("[usage] failed to mark cap", e instanceof Error ? e.message : e);
  }
}

async function loadScope(ids: LlmScopeIds): Promise<Scope> {
  const tier = getCostTier(ids.user);
  const scope: Scope = {
    sessionId: ids.sessionId,
    requestId: ids.requestId,
    tier,
    budgetUsd: budgetUsdForUser(ids.user),
    persistedUsd: 0,
    voiceUsd: 0,
    persistedGrades: 0,
    persistedLearnTurns: 0,
    pending: [],
    capped: false,
    forceMinimum: false,
  };
  if (!ids.sessionId && !ids.requestId) return scope;
  try {
    const db = await getDb();
    const key = ids.requestId ?? ids.sessionId!;
    const spend = await db.get<{ cost: number; grades: number; learns: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(CASE WHEN purpose = 'grade' THEN 1 ELSE 0 END), 0) AS grades,
              COALESCE(SUM(CASE WHEN purpose = 'learn_turn' THEN 1 ELSE 0 END), 0) AS learns
       FROM llm_calls
       WHERE ${ids.requestId ? "request_id = ?" : "session_id = ?"}`,
      [key],
    );
    scope.persistedUsd = Number(spend?.cost ?? 0);
    scope.persistedGrades = Number(spend?.grades ?? 0);
    scope.persistedLearnTurns = Number(spend?.learns ?? 0);
    const session = await db.get<{
      budget_usd: number | null;
      cost_tier: string | null;
      voice_cost_usd: number | null;
    }>(
      ids.sessionId
        ? `SELECT budget_usd, cost_tier, voice_cost_usd FROM sessions WHERE id = ?`
        : `SELECT budget_usd, cost_tier, voice_cost_usd FROM sessions
           WHERE request_id = ? ORDER BY CASE WHEN mode = 'defend' THEN 0 ELSE 1 END, started_at DESC LIMIT 1`,
      [ids.sessionId ?? ids.requestId!],
    );
    if (session?.budget_usd != null && Number.isFinite(Number(session.budget_usd))) {
      scope.budgetUsd = Number(session.budget_usd);
    }
    if (session?.cost_tier === "enterprise" || session?.cost_tier === "consumer") {
      scope.tier = session.cost_tier;
    }
    scope.voiceUsd = Number(session?.voice_cost_usd ?? 0);
  } catch (e) {
    console.error("[usage] budget load failed", e instanceof Error ? e.message : e);
  }
  return scope;
}

function committedUsd(scope: Scope): number {
  const pending = scope.pending.reduce((sum, call) => sum + call.usage.costUsd, 0);
  return scope.persistedUsd + scope.voiceUsd + pending;
}

function isOptional(scope: Scope, purpose: string, modelId: string): boolean {
  if (purpose === "speakable_rewrite") return true;
  if (purpose === "learn_turn") {
    const prior =
      scope.persistedLearnTurns + scope.pending.filter((call) => call.purpose === "learn_turn").length;
    return prior >= 1;
  }
  if (purpose === "grade") {
    return scope.pending.some((call) => call.purpose === "grade" && call.requestedModelId === modelId);
  }
  if (purpose === "write_questions" || purpose === "write_flashcards") {
    return scope.pending.some((call) => call.purpose === purpose);
  }
  return false;
}

function hasGrade(scope: Scope): boolean {
  return scope.persistedGrades > 0 || scope.pending.some((call) => call.purpose === "grade");
}

/** In-scope check used before a session row exists, and as the first look once it does. */
function budgetInMemory(
  scope: Scope,
  purpose: string,
  modelId: string,
  standard: number,
  cheap: number,
): BudgetBegin {
  const committed = committedUsd(scope);
  const room = scope.budgetUsd - committed;
  const fits = (estimate: number) => estimate <= room + 1e-9;

  if (scope.forceMinimum && purpose === "grade") {
    scope.forceMinimum = false;
    noteCap(scope, purpose, "minimum", committed);
    return reserve(scope, purpose, modelId, cheap, true);
  }

  if (fits(standard)) return reserve(scope, purpose, modelId, standard, false);

  if (isOptional(scope, purpose, modelId)) {
    noteCap(scope, purpose, "skip", committed);
    return { allow: false, reservationId: null, useCheap: false };
  }

  if (fits(cheap)) {
    noteCap(scope, purpose, "cheap", committed);
    return reserve(scope, purpose, modelId, cheap, true);
  }

  if (purpose === "grade" && !hasGrade(scope)) {
    noteCap(scope, purpose, "minimum", committed);
    return reserve(scope, purpose, modelId, cheap, true);
  }

  noteCap(scope, purpose, "skip", committed);
  return { allow: false, reservationId: null, useCheap: false };
}

/** A killed function's hold stops counting after this. Grading's own budget is shorter. */
const HOLD_TTL_MS = 2 * 60 * 1000;

function holdCutoffIso(): string {
  return new Date(Date.now() - HOLD_TTL_MS).toISOString();
}

function claimSql(dialect: "sqlite" | "postgres"): string {
  const lock = dialect === "postgres" ? " FOR UPDATE" : "";
  return `WITH locked AS (
  SELECT id, mode, request_id, voice_cost_usd, budget_usd
  FROM sessions WHERE id = ?${lock}
)
INSERT INTO budget_holds (id, session_id, usd, grades, created_at)
SELECT ?, locked.id, ?, ?, ?
FROM locked
WHERE (
  (
    (SELECT COALESCE(SUM(c.cost_usd), 0) FROM llm_calls c
      WHERE (locked.mode = 'defend' AND c.request_id = locked.request_id)
         OR (locked.mode <> 'defend' AND c.session_id = locked.id))
    + COALESCE(locked.voice_cost_usd, 0)
    + COALESCE((
        SELECT SUM(h.usd) FROM budget_holds h
        WHERE h.session_id = locked.id AND h.created_at > ?
      ), 0)
    + ?
  ) <= COALESCE(locked.budget_usd, ?) + 0.000001
  OR (
    ? = 1
    AND COALESCE((
      SELECT SUM(h.grades) FROM budget_holds h
      WHERE h.session_id = locked.id AND h.created_at > ?
    ), 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM llm_calls g
      WHERE g.purpose = 'grade'
        AND (g.session_id = locked.id OR g.request_id = locked.request_id)
    )
  )
)`;
}

async function lookupSession(scope: Scope): Promise<string | null> {
  if (scope.reserveSessionId) return scope.reserveSessionId;
  const db = await getDb();
  const row = scope.sessionId
    ? await db.get<{ id: string }>(`SELECT id FROM sessions WHERE id = ?`, [scope.sessionId])
    : scope.requestId
      ? await db.get<{ id: string }>(
          `SELECT id FROM sessions WHERE request_id = ?
           ORDER BY CASE WHEN mode = 'defend' THEN 0 ELSE 1 END, started_at DESC LIMIT 1`,
          [scope.requestId],
        )
      : undefined;
  if (!row) return null;
  scope.reserveSessionId = row.id;
  return row.id;
}

/** One insert. `changes === 0` means the cap would not hold. Holds older than two minutes do not count. */
async function claimReserve(
  sessionId: string,
  holdId: string,
  estimate: number,
  gradeDelta: number,
  allowOver: number,
  budgetFallback: number,
): Promise<boolean> {
  const db = await getDb();
  const cutoff = holdCutoffIso();
  const now = new Date().toISOString();
  await db.run(`DELETE FROM budget_holds WHERE session_id = ? AND created_at <= ?`, [sessionId, cutoff]);
  const result = await db.run(claimSql(db.dialect), [
    sessionId,
    holdId,
    estimate,
    gradeDelta,
    now,
    cutoff,
    estimate,
    budgetFallback,
    allowOver,
    cutoff,
  ]);
  await refreshReserveTotals(db, sessionId, cutoff);
  return result.changes === 1;
}

async function holdOnSession(
  scope: Scope,
  sessionId: string,
  purpose: string,
  modelId: string,
  estimate: number,
  allowOver: boolean,
  action: "cheap" | "minimum",
): Promise<BudgetBegin | null> {
  const id = newId("llm");
  const gradeDelta = purpose === "grade" ? 1 : 0;
  const claimed = await claimReserve(sessionId, id, estimate, gradeDelta, allowOver ? 1 : 0, scope.budgetUsd);
  if (!claimed) return null;
  noteCap(scope, purpose, action, committedUsd(scope));
  const decision = reserve(scope, purpose, modelId, estimate, true, id);
  const call = scope.pending.find((row) => row.id === decision.reservationId);
  if (call) {
    call.heldUsd = estimate;
    call.heldGrades = gradeDelta;
    call.heldSessionId = sessionId;
    call.holdId = id;
  }
  return decision;
}

function dropPending(scope: Scope, reservationId: string): void {
  const index = scope.pending.findIndex((call) => call.id === reservationId);
  if (index >= 0) scope.pending.splice(index, 1);
}

async function refreshReserveTotals(db: Db, sessionId: string, cutoff = holdCutoffIso()): Promise<void> {
  await db.run(
    `UPDATE sessions SET
      reserved_usd = COALESCE((
        SELECT SUM(usd) FROM budget_holds WHERE session_id = sessions.id AND created_at > ?
      ), 0),
      reserved_grades = COALESCE((
        SELECT SUM(grades) FROM budget_holds WHERE session_id = sessions.id AND created_at > ?
      ), 0)
    WHERE id = ?`,
    [cutoff, cutoff, sessionId],
  );
}

async function releaseHolds(db: Db, calls: PendingCall[]): Promise<void> {
  const sessions = new Set<string>();
  for (const call of calls) {
    if (!call.holdId || !call.heldSessionId) continue;
    await db.run(`DELETE FROM budget_holds WHERE id = ?`, [call.holdId]);
    sessions.add(call.heldSessionId);
  }
  for (const sessionId of sessions) await refreshReserveTotals(db, sessionId);
}

function reserve(
  scope: Scope,
  purpose: string,
  requestedModelId: string,
  estimate: number,
  useCheap: boolean,
  id = newId("llm"),
): BudgetBegin {
  scope.pending.push({
    id,
    purpose,
    provider: "pending",
    modelId: requestedModelId.slice(0, 120),
    requestedModelId: requestedModelId.slice(0, 120),
    usage: { promptTokens: 0, completionTokens: 0, costUsd: estimate, costSource: "estimated" },
    createdAt: new Date().toISOString(),
    reserved: true,
    heldUsd: 0,
    heldGrades: 0,
    heldSessionId: null,
    holdId: null,
  });
  return { allow: true, reservationId: id, useCheap };
}

function noteCap(scope: Scope, purpose: string, action: "skip" | "cheap" | "minimum", committed: number): void {
  scope.capped = true;
  console.info(
    JSON.stringify({
      event: "budget_capped",
      action,
      purpose,
      committedUsd: Number(committed.toFixed(6)),
      capUsd: scope.budgetUsd,
      tier: scope.tier,
      requestId: scope.requestId ?? null,
      sessionId: scope.sessionId ?? null,
    }),
  );
}

async function persistAll(calls: PendingCall[], abandoned: PendingCall[], capped: boolean): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  const sessionId = scope.sessionId ?? null;
  const requestId = scope.requestId ?? null;
  if (!sessionId && !requestId) {
    scope.pending.unshift(...calls);
    return;
  }
  try {
    const db = await getDb();
    await db.transaction(async (tx) => {
      for (const call of calls) {
        await tx.run(
          `INSERT INTO llm_calls
            (id, session_id, request_id, purpose, provider, model_id,
             prompt_tokens, completion_tokens, cost_usd, cost_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            call.id,
            sessionId,
            requestId,
            call.purpose,
            call.provider,
            call.modelId,
            call.usage.promptTokens,
            call.usage.completionTokens,
            call.usage.costUsd,
            call.usage.costSource,
            call.createdAt,
          ],
        );
      }
      if (requestId) await recompute(tx, requestId, sessionBudgetUsd());
      await releaseHolds(tx, [...calls, ...abandoned]);
      if (capped) await markCappedTx(tx, sessionId, requestId);
    });
  } catch (e) {
    console.error("[usage] failed to record model call", e instanceof Error ? e.message : e);
  }
}

async function markCapped(scope: Scope): Promise<void> {
  if (!scope.sessionId && !scope.requestId) return;
  try {
    await markCappedTx(await getDb(), scope.sessionId ?? null, scope.requestId ?? null);
  } catch (e) {
    console.error("[usage] failed to mark cap", e instanceof Error ? e.message : e);
  }
}

async function markCappedTx(db: Db, sessionId: string | null, requestId: string | null): Promise<void> {
  if (sessionId) {
    await db.run(`UPDATE sessions SET budget_capped = 1 WHERE id = ?`, [sessionId]);
  }
  if (requestId) {
    await db.run(`UPDATE sessions SET budget_capped = 1 WHERE request_id = ?`, [requestId]);
  }
}

/**
 * A learn session stores only its own calls. A defend session stores every
 * call on the defense. `over_budget` compares that total with the cap stored
 * on the session (`budget_usd`), falling back to `SESSION_BUDGET_USD` for rows
 * written before per-plan caps.
 */
async function recompute(db: Db, requestId: string, budgetFallback: number): Promise<void> {
  const included = `(sessions.mode = 'defend' AND c.request_id = sessions.request_id)
       OR (sessions.mode <> 'defend' AND c.session_id = sessions.id)`;
  await db.run(
    `UPDATE sessions SET
      prompt_tokens = (
        SELECT COALESCE(SUM(c.prompt_tokens), 0) FROM llm_calls c
        WHERE ${included}
      ),
      completion_tokens = (
        SELECT COALESCE(SUM(c.completion_tokens), 0) FROM llm_calls c
        WHERE ${included}
      ),
      cost_usd = (
        SELECT COALESCE(SUM(c.cost_usd), 0) FROM llm_calls c
        WHERE ${included}
      ),
      over_budget = CASE WHEN (
        SELECT COALESCE(SUM(c.cost_usd), 0) FROM llm_calls c
        WHERE ${included}
      ) > COALESCE(sessions.budget_usd, ?) THEN 1 ELSE 0 END
    WHERE request_id = ?`,
    [budgetFallback, requestId],
  );
}

function readNonNegative(raw: string | undefined, fallback: number): number {
  const n = readUsd(raw);
  return n === null ? fallback : n;
}

function readUsd(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function num(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function whole(n: number): number {
  return Math.max(0, Math.round(n));
}
