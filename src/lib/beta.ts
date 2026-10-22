/** Trial-budget defaults. `credits.ts` reads the same numbers. Env can override them. */

export const BETA_BUDGET_EUR_DEFAULT = 150;
export const BETA_DEFENSE_EUR_DEFAULT = 0.7;

function nonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Euros counted against the shared trial budget for one sponsored defense. */
export function betaDefenseEur(): number {
  return nonNegative("BETA_DEFENSE_EUR", BETA_DEFENSE_EUR_DEFAULT);
}

/** Shared trial budget, in euros. Sponsored defenses stop when it is used. */
export function betaBudgetEur(): number {
  return nonNegative("BETA_BUDGET_EUR", BETA_BUDGET_EUR_DEFAULT);
}
