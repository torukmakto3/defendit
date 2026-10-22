/**
 * Public result tiers for a challenge, read from the receipt score (0–100).
 *
 * The receipt score already uses the cutoffs in `outcomeFor`: 70 and above is
 * "Defended", 45–69 is "Partially defended", and below 45 is "Not defended".
 * The receipt chart treats 75 as a strong claim score. These tiers sit on
 * that scale:
 *
 * - Strong: score >= 85. Comfortably above the Defended line.
 * - Defended: score >= 70 and below 85. The same floor as outcome "Defended".
 * - Still sharpening: score below 70. Partial and weak results stay in one band.
 *
 * A score-hidden result shows the tier and not the number. The number stays
 * off the public page, the OG card, and the public JSON.
 */
export const TIER_STRONG_MIN = 85;
export const TIER_DEFENDED_MIN = 70;

export type ResultTier = "Strong" | "Defended" | "Still sharpening";

export function tierForScore(score: number): ResultTier {
  if (score >= TIER_STRONG_MIN) return "Strong";
  if (score >= TIER_DEFENDED_MIN) return "Defended";
  return "Still sharpening";
}

/** Public title. A score under 70 is "Still sharpening" with no extra prefix. */
export function publicTierTitle(tier: ResultTier | string | null): string {
  if (tier === "Still sharpening") return "Still sharpening";
  if (!tier) return "Defended";
  return `Defended · ${tier}`;
}

export const TIER_LEGEND =
  "Strong is the top band, 85 or higher. Defended is 70 to 84. Under 70 is still sharpening, framed as progress.";

/** Free beta challenges. Default off. */
export function challengesEnabled(): boolean {
  return process.env.CHALLENGES_ENABLED === "1" || process.env.CHALLENGES_ENABLED === "true";
}
