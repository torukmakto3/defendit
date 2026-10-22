/**
 * Price list and plan allowances (EUR, VAT included).
 * The UI reads this module. It does not hard-code prices.
 *
 * A defense and a challenge each cost 1 credit. Pack credits are flexible:
 * they can pay for either. Subscription challenge credits do not roll over.
 *
 * `costTier` is what the per-defense cost cap reads (consumer $0.75,
 * enterprise $3). This module exposes the tier. It does not enforce the cap.
 */

export type CostCapTier = "consumer" | "enterprise";

/** Live charges stay off unless this is exactly "1" or "true". `false` and unset stay off. */
export function billingEnabled(): boolean {
  const value = process.env.BILLING_ENABLED;
  return value === "1" || value === "true";
}

export type PlanId = "beta" | "payg" | "subscription" | "team" | "enterprise";

export type BillingInterval = "month" | "year";

/** USD ceiling for a tier. Enforcement belongs to the cost-cap work. */
export const COST_CAP_USD: Record<CostCapTier, number> = {
  consumer: 0.75,
  enterprise: 3,
};

/** Defaults for the one-time beta grant. Defense count is overridable. */
export const BETA_GRANT = {
  defense: 3,
  challenge: 2,
  learnSlots: 3,
} as const;

/** Free defenses granted once per account. `BETA_DEFENSE_CREDITS`, default 3. */
export function betaDefenseCredits(): number {
  const raw = process.env.BETA_DEFENSE_CREDITS;
  if (raw == null || raw.trim() === "") return BETA_GRANT.defense;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) return BETA_GRANT.defense;
  return n;
}

/** Challenge credit granted when someone finishes a defense they were challenged into. */
export const ONWARD_CHALLENGE_CREDITS = 1;

export const PAYG_CENTS = {
  defense: 400,
  challenge: 300,
} as const;

export const PACKS = {
  pack3: { credits: 3, priceCents: 1000 },
  pack8: { credits: 8, priceCents: 2000 },
} as const;

export type PackSku = keyof typeof PACKS;

export type Sku =
  | "defense"
  | "challenge"
  | PackSku
  | "subscription_month"
  | "subscription_year"
  | "team_month"
  | "enterprise_month";

export interface Plan {
  id: PlanId;
  name: string;
  costTier: CostCapTier;
  /** Configured ceiling for this tier, in USD. Not enforced here. */
  sessionBudgetUsd: number;
  defensesPerPeriod: number;
  challengesPerPeriod: number;
  /** Unused subscription challenges expire at the next renewal. */
  challengesRollOver: boolean;
  /** The defense count is the allowance for the period. */
  defensesRollOver: boolean;
  /** null: no Learn-slot cap. */
  learnSlots: number | null;
  priceCents: { month: number | null; year: number | null };
  /** Cents charged for a defense past the included amount. null: no overage. */
  overageCents: number | null;
}

const CONSUMER = COST_CAP_USD.consumer;
const ENTERPRISE = COST_CAP_USD.enterprise;

const PLANS: Record<PlanId, Plan> = {
  beta: {
    id: "beta",
    name: "Beta",
    costTier: "consumer",
    sessionBudgetUsd: CONSUMER,
    defensesPerPeriod: 0,
    challengesPerPeriod: 0,
    challengesRollOver: false,
    defensesRollOver: false,
    learnSlots: BETA_GRANT.learnSlots,
    priceCents: { month: null, year: null },
    overageCents: null,
  },
  payg: {
    id: "payg",
    name: "Pay as you go",
    costTier: "consumer",
    sessionBudgetUsd: CONSUMER,
    defensesPerPeriod: 0,
    challengesPerPeriod: 0,
    challengesRollOver: false,
    defensesRollOver: false,
    learnSlots: null,
    priceCents: { month: null, year: null },
    overageCents: null,
  },
  subscription: {
    id: "subscription",
    name: "Subscription",
    costTier: "consumer",
    sessionBudgetUsd: CONSUMER,
    defensesPerPeriod: 10,
    challengesPerPeriod: 5,
    challengesRollOver: false,
    defensesRollOver: false,
    learnSlots: 10,
    priceCents: { month: 1100, year: 9900 },
    overageCents: null,
  },
  team: {
    id: "team",
    name: "Team",
    costTier: "enterprise",
    sessionBudgetUsd: ENTERPRISE,
    defensesPerPeriod: 50,
    challengesPerPeriod: 0,
    challengesRollOver: false,
    defensesRollOver: false,
    learnSlots: null,
    priceCents: { month: 14900, year: null },
    overageCents: null,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    costTier: "enterprise",
    sessionBudgetUsd: ENTERPRISE,
    defensesPerPeriod: 200,
    challengesPerPeriod: 0,
    challengesRollOver: false,
    defensesRollOver: false,
    learnSlots: null,
    priceCents: { month: 49000, year: null },
    overageCents: 250,
  },
};

export function subscriptionChallengeCredits(): number {
  const raw = process.env.SUBSCRIPTION_CHALLENGE_CREDITS;
  if (raw == null || raw.trim() === "") return PLANS.subscription.challengesPerPeriod;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) return PLANS.subscription.challengesPerPeriod;
  return n;
}

export function getPlan(id: PlanId): Plan {
  const plan = PLANS[id];
  if (id === "subscription") {
    return { ...plan, challengesPerPeriod: subscriptionChallengeCredits() };
  }
  return plan;
}

export function isPlanId(value: string): value is PlanId {
  switch (value) {
    case "beta":
    case "payg":
    case "subscription":
    case "team":
    case "enterprise":
      return true;
    default:
      return false;
  }
}

/** Tier a stored plan id maps to. Unknown ids are consumer. */
export function costTierForPlan(planId: string): CostCapTier {
  if (!isPlanId(planId)) return "consumer";
  return getPlan(planId).costTier;
}

export function formatEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = abs / 100;
  const body = Number.isInteger(euros) ? String(euros) : euros.toFixed(2);
  return `${sign}€${body}`;
}

export function skuPriceCents(sku: Sku): number {
  switch (sku) {
    case "defense":
      return PAYG_CENTS.defense;
    case "challenge":
      return PAYG_CENTS.challenge;
    case "pack3":
      return PACKS.pack3.priceCents;
    case "pack8":
      return PACKS.pack8.priceCents;
    case "subscription_month":
      return PLANS.subscription.priceCents.month ?? 0;
    case "subscription_year":
      return PLANS.subscription.priceCents.year ?? 0;
    case "team_month":
      return PLANS.team.priceCents.month ?? 0;
    case "enterprise_month":
      return PLANS.enterprise.priceCents.month ?? 0;
    default: {
      const unknown: never = sku;
      return unknown;
    }
  }
}

export function isSku(value: string): value is Sku {
  switch (value) {
    case "defense":
    case "challenge":
    case "pack3":
    case "pack8":
    case "subscription_month":
    case "subscription_year":
    case "team_month":
    case "enterprise_month":
      return true;
    default:
      return false;
  }
}

/** How many monthly allowances a renewal pays for. A year is twelve periods, paid once. */
export function periodsForInterval(interval: BillingInterval): number {
  switch (interval) {
    case "month":
      return 1;
    case "year":
      return 12;
    default: {
      const unknown: never = interval;
      return unknown;
    }
  }
}

export function planForSku(sku: Sku): { planId: PlanId; interval: BillingInterval } | null {
  switch (sku) {
    case "subscription_month":
      return { planId: "subscription", interval: "month" };
    case "subscription_year":
      return { planId: "subscription", interval: "year" };
    case "team_month":
      return { planId: "team", interval: "month" };
    case "enterprise_month":
      return { planId: "enterprise", interval: "month" };
    case "defense":
    case "challenge":
    case "pack3":
    case "pack8":
      return null;
    default: {
      const unknown: never = sku;
      return unknown;
    }
  }
}
