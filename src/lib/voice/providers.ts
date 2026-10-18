import { textVoiceProvider } from "./text";
import type { VoiceProvider } from "./types";

/**
 * Pluggable voice backends.
 * Beta path: text (default) or cascaded OSS STT→LLM→TTS later.
 * Commercial: ElevenLabs Agents / OpenAI Realtime when keys exist.
 */
export function getVoiceProvider(): VoiceProvider {
  const preferred = process.env.VOICE_PROVIDER || "text";

  if (preferred === "elevenlabs" && process.env.ELEVENLABS_API_KEY) {
    return elevenLabsStub;
  }
  if (preferred === "openai-realtime" && process.env.OPENAI_API_KEY) {
    return openAIRealtimeStub;
  }
  if (preferred === "oss-cascade") {
    return ossCascadeStub;
  }
  return textVoiceProvider;
}

const elevenLabsStub: VoiceProvider = {
  id: "elevenlabs",
  modality: "voice",
  async createSession() {
    throw new Error(
      "ElevenLabs Agents adapter is stubbed. Set VOICE_PROVIDER=text or implement createSession in src/lib/voice/providers.ts.",
    );
  },
};

const openAIRealtimeStub: VoiceProvider = {
  id: "openai-realtime",
  modality: "voice",
  async createSession() {
    throw new Error(
      "OpenAI Realtime adapter is stubbed. Set VOICE_PROVIDER=text or implement createSession in src/lib/voice/providers.ts.",
    );
  },
};

/** Planned: Whisper/Parakeet → OSS LLM → Kokoro/Orpheus (see docs/model_strategy.md). */
const ossCascadeStub: VoiceProvider = {
  id: "oss-cascade",
  modality: "voice",
  async createSession() {
    throw new Error(
      "OSS cascaded voice is planned. Use VOICE_PROVIDER=text for now, or implement Speaches/HF speech-to-speech in src/lib/voice/providers.ts.",
    );
  },
};
