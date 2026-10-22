import { HttpError } from "./errors";
import { billingEnabled } from "./plans";

/**
 * Billing switch. Paid challenges and card checkout stay off unless
 * `BILLING_ENABLED` is "1" or "true", the same parser as `src/lib/plans.ts`.
 * This module never imports a payment SDK. Balances live in `src/lib/credits.ts`,
 * and a refund there returns credit.
 */

export { billingEnabled };

/** Refuse a paid challenge when billing is off. No credit row is written. */
export function assertPaidChallengesOpen(): void {
  if (!billingEnabled()) {
    throw new HttpError(402, "Paid challenges are turned off.");
  }
}
