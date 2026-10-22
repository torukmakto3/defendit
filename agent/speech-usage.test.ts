import { describe, expect, it } from "vitest";
import { emptySpeechTotals, noteSpeechMetric } from "./src/speech-usage";

describe("LiveKit speech metrics", () => {
  it("adds STT and TTS audio and ignores other events", () => {
    const totals = emptySpeechTotals();
    noteSpeechMetric(totals, { type: "stt_metrics", audioDurationMs: 2500 });
    noteSpeechMetric(totals, { type: "tts_metrics", audioDurationMs: 1000 });
    noteSpeechMetric(totals, { type: "llm_metrics", audioDurationMs: 99999 });
    noteSpeechMetric(totals, { type: "tts_metrics", audioDuration: 0.5 });
    noteSpeechMetric(totals, null);
    expect(totals).toEqual({ sttSeconds: 2.5, ttsSeconds: 1.5 });
  });
});
