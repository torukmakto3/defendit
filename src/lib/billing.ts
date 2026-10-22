import { HttpError } from "./errors";

/**
 * Billing switch. Paid challenges and card checkout stay off unless
 * `BILLING_ENABLED=1`. This module never imports a payment SDK.
 * Balances live in `src/lib/credits.ts`, and a refund there returns credit.
 */

export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "1";
}

/** Refuse a paid challenge when billing is off. No credit row is written. */
export function assertPaidChallengesOpen(): void {
  if (!billingEnabled()) {
    throw new HttpError(402, "Paid challenges are turned off.");
  }
}
