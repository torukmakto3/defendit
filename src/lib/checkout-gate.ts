/**
 * One paid plan at a time. A second Stripe subscription's renewal or end
 * expires the credits on the plan already stored. Founding is not started
 * while that subscription is still open, and Checkout does not cancel it.
 */

export interface CheckoutGatePlan {
  interval: "month" | "year" | "lifetime" | null;
  status: string;
}

const BLOCKING_STATUS = new Set(["active", "trialing", "past_due"]);
const SUBSCRIPTION_SKUS = new Set(["subscription_month", "subscription_year", "team_month"]);

export const SECOND_SUBSCRIPTION_MESSAGE =
  "You already have a paid plan. Use the billing portal to switch or cancel. Checkout will not start another subscription.";

export const FOUNDING_AFTER_CANCEL_MESSAGE =
  "Cancel the current subscription in the billing portal and wait until it ends before buying a founding membership. This checkout does not cancel that subscription.";

export const LIFETIME_BLOCKS_SUBSCRIPTION_MESSAGE =
  "A founding membership is on this account. Pro and Team checkout stays closed. Use the billing portal to see invoices.";

export const ALREADY_FOUNDING_MESSAGE = "You already have a founding membership.";

export function paidPlanBlocksCheckout(plan: CheckoutGatePlan | null): boolean {
  if (!plan || !BLOCKING_STATUS.has(plan.status)) return false;
  return plan.interval === "month" || plan.interval === "year" || plan.interval === "lifetime";
}

/** Portal replaces Checkout for Pro, Team, and Founding while a paid plan is open. Packs stay on Checkout. */
export function checkoutUiAction(sku: string, plan: CheckoutGatePlan | null): "checkout" | "portal" {
  if (!paidPlanBlocksCheckout(plan)) return "checkout";
  if (SUBSCRIPTION_SKUS.has(sku) || sku === "founding_lifetime") return "portal";
  return "checkout";
}

export function checkoutBlockMessage(sku: string, plan: CheckoutGatePlan): string {
  if (sku === "founding_lifetime") {
    if (plan.interval === "lifetime") return ALREADY_FOUNDING_MESSAGE;
    return FOUNDING_AFTER_CANCEL_MESSAGE;
  }
  if (plan.interval === "lifetime") return LIFETIME_BLOCKS_SUBSCRIPTION_MESSAGE;
  return SECOND_SUBSCRIPTION_MESSAGE;
}
