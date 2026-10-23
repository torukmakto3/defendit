import { describe, expect, it } from "vitest";
import { selectTts } from "./src/tts";

// Lives beside the agent, not under tests/. Next typechecks tests/ during
// `next build`, and Vercel does not upload /agent (.vercelignore).

describe("interviewer TTS provider", () => {
  it("keeps LiveKit Inference Aura-2 when nothing is set", () => {
    expect(selectTts({})).toEqual({ kind: "deepgram-inference", descriptor: "deepgram/aura-2", language: "en" });
  });

  it("keeps the Thalia plugin, with mip_opt_out, when a Deepgram key is set", () => {
    expect(selectTts({ DEEPGRAM_API_KEY: "dg-test", TTS_PROVIDER: " Deepgram " })).toEqual({
      kind: "deepgram-plugin",
      model: "aura-2-thalia-en",
      language: "en",
      mipOptOut: true,
    });
  });

  it("ignores TTS_VOICE while the provider is Deepgram", () => {
    expect(selectTts({ TTS_VOICE: "ara", DEEPGRAM_API_KEY: "dg-test" })).toEqual({
      kind: "deepgram-plugin",
      model: "aura-2-thalia-en",
      language: "en",
      mipOptOut: true,
    });
  });

  it("selects xAI Ara through LiveKit Inference even if a Deepgram key is present", () => {
    expect(selectTts({ TTS_PROVIDER: "xai", DEEPGRAM_API_KEY: "dg-test" })).toEqual({
      kind: "xai-inference",
      model: "xai/tts-1",
      voice: "ara",
      descriptor: "xai/tts-1:ara",
      language: "en",
    });
  });

  it("accepts the grok alias and a listed voice", () => {
    expect(selectTts({ TTS_PROVIDER: "grok", TTS_VOICE: "Luna" })).toEqual({
      kind: "xai-inference",
      model: "xai/tts-1",
      voice: "luna",
      descriptor: "xai/tts-1:luna",
      language: "en",
    });
  });

  it("speaks Spanish with Aura-2 Estrella and Portuguese with xAI because Aura-2 has no Portuguese voice", () => {
    expect(selectTts({ DEEPGRAM_API_KEY: "dg-test" }, "es")).toEqual({
      kind: "deepgram-plugin",
      model: "aura-2-estrella-es",
      language: "es",
      mipOptOut: true,
    });
    expect(selectTts({}, "es-MX")).toEqual({
      kind: "deepgram-inference",
      descriptor: "deepgram/aura-2",
      voice: "estrella",
      language: "es",
    });
    expect(selectTts({ DEEPGRAM_API_KEY: "dg-test" }, "pt")).toEqual({
      kind: "xai-inference",
      model: "xai/tts-1",
      voice: "ara",
      descriptor: "xai/tts-1:ara",
      language: "pt-BR",
      note: "aura-2-has-no-portuguese",
    });
    expect(selectTts({ TTS_PROVIDER: "xai" }, "pt")).toMatchObject({ language: "pt-BR", voice: "ara" });
    expect(selectTts({ TTS_PROVIDER: "xai" }, "es")).toMatchObject({ language: "es", voice: "ara" });
  });

  it("rejects an unknown provider and an unknown voice", () => {
    expect(() => selectTts({ TTS_PROVIDER: "elevenlabs" })).toThrow(/Unknown TTS_PROVIDER/);
    expect(() => selectTts({ TTS_PROVIDER: "xai", TTS_VOICE: "thalia" })).toThrow(/Unknown TTS_VOICE/);
  });
});
