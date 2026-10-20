import { describeGradingCouncil } from "./lib/llm";

/**
 * A deployment with a router or a one-model council must not become ready to
 * grade. `next build` skips this; the server checks again before it listens.
 */
export function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const label = describeGradingCouncil();
  if (label.startsWith("Grading is refused")) {
    throw new Error(label);
  }
}
