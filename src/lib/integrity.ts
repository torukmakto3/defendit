import type { IntegritySignals, TurnRecord } from "./types";

/** A client total is a non-negative integer. Anything else counts as zero. */
export function clampIntegrityCount(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(10_000, Math.floor(n));
}

/** Status plus the stored totals, for the receipt page and the PDF. */
export function integritySummary(integrity: {
  status: string;
  pasteEvents?: number;
  focusBlurEvents?: number;
}): string {
  const parts = [integrity.status];
  const pastes = clampIntegrityCount(integrity.pasteEvents);
  const blurs = clampIntegrityCount(integrity.focusBlurEvents);
  if (pastes > 0) parts.push(`${pastes} ${pastes === 1 ? "paste" : "pastes"}`);
  if (blurs > 0) parts.push(`${blurs} ${blurs === 1 ? "focus loss" : "focus losses"}`);
  return parts.join(" · ");
}

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
