import { assertIpHashConfigured } from "./lib/ip-hash";
import { describeGradingCouncil } from "./lib/llm";
import { assertStripeReady } from "./lib/stripe-config";

/**
 * A deployment with a router or a one-model council must not become ready to
 * grade. Payments that are on with a live Stripe key must not become ready
 * either. `next build` skips this; the server checks again before it listens.
 */
export function registerNode(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  assertStripeReady();
  // A missing salt is logged. The process still listens; IP limits are skipped.
  assertIpHashConfigured();
  const label = describeGradingCouncil();
  if (label.startsWith("Grading is refused")) {
    throw new Error(label);
  }
}
