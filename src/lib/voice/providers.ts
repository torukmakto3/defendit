import { textVoiceProvider } from "./text";
import type { VoiceProvider } from "./types";

/**
 * Pluggable voice backends. Wire ElevenLabs Agents or OpenAI Realtime here
 * when API keys exist; until then we always fall back to text.
 */
export function getVoiceProvider(): VoiceProvider {
  const preferred = process.env.VOICE_PROVIDER || "text";

  if (preferred === "elevenlabs" && process.env.ELEVENLABS_API_KEY) {
    return elevenLabsStub;
  }
  if (preferred === "openai-realtime" && process.env.OPENAI_API_KEY) {
    return openAIRealtimeStub;
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
