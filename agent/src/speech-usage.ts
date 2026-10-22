/** STT/TTS seconds taken from LiveKit metrics, when the agent emits them. */
export interface SpeechTotals {
  sttSeconds: number;
  ttsSeconds: number;
}

export function emptySpeechTotals(): SpeechTotals {
  return { sttSeconds: 0, ttsSeconds: 0 };
}

/**
 * Add one metrics event. LiveKit reports `audioDurationMs`.
 * Unknown event types are ignored so a new metric cannot break the interview.
 */
export function noteSpeechMetric(
  totals: SpeechTotals,
  metric: { type?: string; audioDurationMs?: number; audioDuration?: number } | null | undefined,
): void {
  if (!metric?.type) return;
  const fromMs = positive(metric.audioDurationMs);
  const seconds = fromMs !== undefined ? fromMs / 1000 : positive(metric.audioDuration);
  if (seconds === undefined) return;
  if (metric.type === "stt_metrics") totals.sttSeconds += seconds;
  else if (metric.type === "tts_metrics") totals.ttsSeconds += seconds;
}

function positive(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}
