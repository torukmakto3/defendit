import { TIER_STRONG_MIN } from "./challenge-tier";

/**
 * Score lines shared by grading and the public pages.
 * Change a cutoff here and the receipt, the chart, and the copy move together.
 */

/** Receipt outcome on the 0–100 score. Inclusive floors. */
export const DEFENDED_MIN_SCORE = 70;
export const PARTIAL_MIN_SCORE = 45;

/** Per-claim chart bands on the 0–100 claim score. Inclusive floors. */
export const STRONG_CLAIM_SCORE = 75;
export const PARTIAL_CLAIM_SCORE = 50;

/** Rubric band on the 0–4 average level. Inclusive floors. */
export const STRONG_LEVEL = 3;
export const PARTIAL_LEVEL = 2;

/**
 * Public challenge label, above the receipt's Defended line.
 * This is `TIER_STRONG_MIN` from `tierForScore`: that score and above is
 * Strong. From the Defended line up to this score the public label is
 * Defended. Under the Defended line it is Still sharpening.
 */
export const CHALLENGE_STRONG_MIN_SCORE = TIER_STRONG_MIN;
