import { AsyncLocalStorage } from "node:async_hooks";
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
 * that defense, so the $3 flag sees claims, Learn, flashcards, question
 * wording, and each council grader.
 */

const DEFAULT_BUDGET_USD = 3;
const DEFAULT_INPUT_PER_MTOK = 0.15;
const DEFAULT_OUTPUT_PER_MTOK = 0.6;

interface Scope {
  sessionId?: string;
  requestId?: string;
  pending: PendingCall[];
}

interface PendingCall {
  id: string;
  purpose: string | null;
  provider: string;
  modelId: string;
  usage: LlmUsage;
  createdAt: string;
}

const scopes = new AsyncLocalStorage<Scope>();

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

export function withLlmScope<T>(
  ids: { sessionId?: string; requestId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  return scopes.run({ sessionId: ids.sessionId, requestId: ids.requestId, pending: [] }, fn);
}

/** Attach calls that ran before the defense request (or session) row existed. */
export async function flushLlmScope(ids: { sessionId?: string; requestId?: string }): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  if (ids.sessionId) scope.sessionId = ids.sessionId;
  if (ids.requestId) scope.requestId = ids.requestId;
  const pending = scope.pending.splice(0);
  for (const call of pending) await persist(call);
}

export async function recordLlmCall(input: {
  purpose?: string;
  provider: string;
  modelId: string;
  usage: LlmUsage;
}): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  const call: PendingCall = {
    id: newId("llm"),
    purpose: input.purpose?.slice(0, 80) || null,
    provider: input.provider.slice(0, 40),
    modelId: input.modelId.slice(0, 120),
    usage: input.usage,
    createdAt: new Date().toISOString(),
  };
  if (!scope.sessionId && !scope.requestId) {
    scope.pending.push(call);
    return;
  }
  await persist(call);
}

/** Recompute stored totals after a session row is inserted. */
export async function refreshRequestUsage(requestId: string): Promise<void> {
  try {
    await recompute(await getDb(), requestId);
  } catch (e) {
    console.error("[usage] failed to refresh session totals", e instanceof Error ? e.message : e);
  }
}

async function persist(call: PendingCall): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  const sessionId = scope.sessionId ?? null;
  const requestId = scope.requestId ?? null;
  if (!sessionId && !requestId) {
    scope.pending.push(call);
    return;
  }
  try {
    const db = await getDb();
    await db.transaction(async (tx) => {
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
      if (requestId) await recompute(tx, requestId);
    });
  } catch (e) {
    console.error("[usage] failed to record model call", e instanceof Error ? e.message : e);
  }
}

/**
 * A learn session stores only its own calls. A defend session stores every
 * call on the defense, which is the total compared with SESSION_BUDGET_USD.
 */
async function recompute(db: Db, requestId: string): Promise<void> {
  const budget = sessionBudgetUsd();
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
      ) > ? THEN 1 ELSE 0 END
    WHERE request_id = ?`,
    [budget, requestId],
  );
}

function readNonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
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
