import type { IntegritySignals, TurnRecord } from "./types";

export function computeIntegrity(opts: {
  turns: TurnRecord[];
  pasteEvents?: number;
  focusBlurEvents?: number;
}): IntegritySignals {
  const latencies = opts.turns.map((t) => t.latencyMs).filter((n) => n > 0);
  const avg =
    latencies.length === 0
      ? 0
      : latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const variance =
    latencies.length < 2
      ? 0
      : latencies.reduce((s, x) => s + (x - avg) ** 2, 0) / latencies.length;

  const pasteEvents = opts.pasteEvents ?? 0;
  const focusBlurEvents = opts.focusBlurEvents ?? 0;
  const observations: string[] = [];

  // Flatline latency (gaming heuristic): low variance across answers
  const flatline =
    latencies.length >= 3 && Math.sqrt(variance) < 800 && avg > 2500;
  if (flatline) {
    observations.push(
      "Response latency was unusually uniform across questions (possible coaching delay).",
    );
  }

  if (pasteEvents > 0) {
    observations.push(`Paste events detected: ${pasteEvents}.`);
  }
  if (focusBlurEvents >= 4) {
    observations.push(
      `Frequent focus loss (${focusBlurEvents} blur events) during the interview.`,
    );
  }

  const veryFast = latencies.filter((l) => l < 1500).length;
  if (veryFast >= Math.ceil(latencies.length * 0.6) && latencies.length >= 3) {
    observations.push(
      "Many answers submitted unusually quickly relative to question difficulty.",
    );
  }

  let status: IntegritySignals["status"] = "Clear";
  if (observations.length >= 2 || pasteEvents > 0) status = "Concerns";
  else if (observations.length === 1) status = "Review";

  if (status === "Clear") {
    observations.push(
      "No focus-loss or paste flags; latency varied with question length.",
    );
  }

  return {
    status,
    observations,
    avgLatencyMs: Math.round(avg),
    latencyVariance: Math.round(variance),
    pasteEvents,
    focusBlurEvents,
  };
}
