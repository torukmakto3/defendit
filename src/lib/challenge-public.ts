/**
 * Challenge rules the public pages describe.
 *
 * Defaults match `src/lib/challenges.ts`: `CHALLENGE_UNCLAIMED_DAYS`,
 * `CHALLENGE_FINISH_HOURS`, `openPerCreator`, `dailyPerCreator`,
 * `openPerDefender`, and the handle cap in `setOptOut` (`.slice(0, 8)`).
 * The day and hour helpers are not exported, so those two defaults are
 * copied here. Update both places together.
 */

/** Days an unclaimed challenge stays open. */
export const CHALLENGE_UNCLAIMED_DAYS_DEFAULT = 7;

/** Hours to finish after the link is accepted. */
export const CHALLENGE_FINISH_HOURS_DEFAULT = 72;

/** Unfinished challenges one sender may have at once. */
export const CHALLENGE_OPEN_PER_CREATOR_DEFAULT = 3;

/** Challenges one sender may create per rolling day. */
export const CHALLENGE_DAILY_PER_CREATOR_DEFAULT = 3;

/** Claimed challenges one person may hold at once. */
export const CHALLENGE_OPEN_PER_DEFENDER_DEFAULT = 1;

/** Handles someone may add to the do-not-challenge list, besides their email. */
export const CHALLENGE_OPT_OUT_HANDLES_MAX = 8;
