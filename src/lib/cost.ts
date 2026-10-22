import { isAdminEmail, normalizeEmail } from "./auth";

/**
 * Per-defense cost tier. `getCostTier` is the only user → tier mapping.
 * Callers stay on that function when the plan model arrives.
 */
export type CostTier = "consumer" | "enterprise";

const CONSUMER_DEFAULT_USD = 0.75;
const ENTERPRISE_DEFAULT_USD = 3;

/** Predicted cost of one model call before it is sent. Matches Liquid's per-call cap. */
const STANDARD_RESERVE_USD = 0.05;
/** Predicted cost of the small model (`llama-3.1-8b-instruct` / `FLASHCARD_MODEL`). */
const CHEAP_RESERVE_USD = 0.01;

/**
 * Cap tier for this account.
 *
 * TODO(#43): when `src/lib/plans.ts` is on main, read the account's plan and
 * return `costTierForPlan(planId)` from that module (team and enterprise are
 * the enterprise cap; beta, payg, and subscription stay consumer). Do not
 * import `plans.ts` until that PR has merged. Until then the tier comes from
 * the email: admins and `COST_TIER_ENTERPRISE_EMAILS` are enterprise.
 */
export function getCostTier(user: { email: string } | null | undefined): CostTier {
  return costTierFromEmail(user);
}

function costTierFromEmail(user: { email: string } | null | undefined): CostTier {
  if (!user?.email) return "consumer";
  if (isAdminEmail(user.email)) return "enterprise";
  if (enterpriseAllowlistHas(user.email)) return "enterprise";
  return "consumer";
}

/**
 * Cap for a tier. `SESSION_BUDGET_USD_CONSUMER` / `SESSION_BUDGET_USD_ENTERPRISE`
 * win when set. Otherwise the tier default applies ($0.75 consumer, $3
 * enterprise). A legacy `SESSION_BUDGET_USD` does not replace those defaults.
 * It is only the fallback for sessions stored before per-plan caps
 * (`sessions.budget_usd` is null); see `sessionBudgetUsd`.
 */
export function budgetUsdForTier(tier: CostTier): number {
  const specific = readUsd(
    tier === "enterprise" ? process.env.SESSION_BUDGET_USD_ENTERPRISE : process.env.SESSION_BUDGET_USD_CONSUMER,
  );
  if (specific !== null) return specific;
  switch (tier) {
    case "consumer":
      return CONSUMER_DEFAULT_USD;
    case "enterprise":
      return ENTERPRISE_DEFAULT_USD;
    default: {
      const _exhaustive: never = tier;
      return _exhaustive;
    }
  }
}

export function budgetUsdForUser(user: { email: string } | null | undefined): number {
  return budgetUsdForTier(getCostTier(user));
}

export function callReserveUsd(kind: "standard" | "cheap"): number {
  const raw = kind === "cheap" ? process.env.CHEAP_LLM_RESERVE_USD : process.env.LLM_CALL_RESERVE_USD;
  const configured = readUsd(raw);
  if (configured !== null) return configured;
  switch (kind) {
    case "standard":
      return STANDARD_RESERVE_USD;
    case "cheap":
      return CHEAP_RESERVE_USD;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export interface VoiceRates {
  agentPerMin: number;
  sttPerMin: number;
  ttsPerMin: number;
}

/** LiveKit list prices from the pricing memo: agent session, STT, TTS. */
export function voiceRates(): VoiceRates {
  return {
    agentPerMin: readUsd(process.env.LIVEKIT_RATE_AGENT_MIN) ?? 0.01,
    sttPerMin: readUsd(process.env.LIVEKIT_RATE_STT_MIN) ?? 0.0048,
    ttsPerMin: readUsd(process.env.LIVEKIT_RATE_TTS_MIN) ?? 0.009,
  };
}

export function voiceCostUsd(
  input: { agentSeconds: number; sttSeconds?: number; ttsSeconds?: number },
  rates: VoiceRates = voiceRates(),
): number {
  const minutes = (seconds: number | undefined) => Math.max(0, seconds ?? 0) / 60;
  return (
    minutes(input.agentSeconds) * rates.agentPerMin +
    minutes(input.sttSeconds) * rates.sttPerMin +
    minutes(input.ttsSeconds) * rates.ttsPerMin
  );
}

/** A second grading round is one call per council member at the standard reserve. */
export function secondRoundFits(spentUsd: number, budgetUsd: number, calls: number): boolean {
  const n = Number.isFinite(calls) && calls > 0 ? calls : 1;
  return spentUsd + n * callReserveUsd("standard") <= budgetUsd + 1e-9;
}

export function costReportLimit(): number {
  const n = readUsd(process.env.COST_REPORT_LIMIT);
  if (n === null) return 50;
  return Math.max(1, Math.floor(n));
}

export interface CostSample {
  totalUsd: number;
  llmUsd: number;
  voiceUsd: number;
  capped: boolean;
}

export interface CostSummary {
  count: number;
  cappedCount: number;
  p50Usd: number;
  p90Usd: number;
  maxUsd: number;
  llmUsd: number;
  voiceUsd: number;
}

/** p50 / p90 / max of total cost, plus the LLM vs voice split, over the given defenses. */
export function summarizeCosts(samples: CostSample[]): CostSummary {
  const totals = samples.map((sample) => sample.totalUsd).sort((a, b) => a - b);
  return {
    count: samples.length,
    cappedCount: samples.filter((sample) => sample.capped).length,
    p50Usd: percentile(totals, 50),
    p90Usd: percentile(totals, 90),
    maxUsd: totals.length ? totals[totals.length - 1] : 0,
    llmUsd: samples.reduce((sum, sample) => sum + sample.llmUsd, 0),
    voiceUsd: samples.reduce((sum, sample) => sum + sample.voiceUsd, 0),
  };
}

export function parseCostTier(value: string | null | undefined): CostTier {
  return value === "enterprise" ? "enterprise" : "consumer";
}

function enterpriseAllowlistHas(email: string): boolean {
  const normalized = normalizeEmail(email);
  return (process.env.COST_TIER_ENTERPRISE_EMAILS || "")
    .split(",")
    .some((pattern) => matchesAllowlist(normalized, pattern));
}

function matchesAllowlist(email: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  return p.startsWith("*@") ? email.endsWith(p.slice(1)) : email === p;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function readUsd(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
