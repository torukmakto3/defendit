/**
 * Which voice speaks the scripted interview.
 *
 * Deepgram Aura-2 Thalia stays the default. TTS_PROVIDER=xai selects xAI
 * Grok TTS through LiveKit Inference (model xai/tts-1). The official xAI
 * plugin is Python-only, so this Node agent does not read XAI_API_KEY.
 * Voices are the ones LiveKit Inference documents for that model.
 */

export const XAI_VOICES = [
  "altair",
  "ara",
  "atlas",
  "carina",
  "castor",
  "celeste",
  "cosmo",
  "eve",
  "helios",
  "helix",
  "iris",
  "kepler",
  "leo",
  "lumen",
  "luna",
  "lux",
  "naksh",
  "orion",
  "perseus",
  "rex",
  "rigel",
  "sal",
  "sirius",
  "ursa",
  "zagan",
  "zenith",
] as const;

export type XaiVoice = (typeof XAI_VOICES)[number];

export type TtsChoice =
  | { kind: "deepgram-plugin"; model: "aura-2-thalia-en"; mipOptOut: true }
  | { kind: "deepgram-inference"; descriptor: "deepgram/aura-2" }
  | { kind: "xai-inference"; model: "xai/tts-1"; voice: XaiVoice; descriptor: `xai/tts-1:${XaiVoice}` };

const DEEPGRAM = new Set(["", "deepgram", "aura", "aura-2"]);
const XAI = new Set(["xai", "grok"]);

function isXaiVoice(value: string): value is XaiVoice {
  return (XAI_VOICES as readonly string[]).includes(value);
}

export function selectTts(env: Record<string, string | undefined>): TtsChoice {
  const provider = (env.TTS_PROVIDER ?? "").trim().toLowerCase();

  if (DEEPGRAM.has(provider)) {
    if (env.DEEPGRAM_API_KEY) {
      return { kind: "deepgram-plugin", model: "aura-2-thalia-en", mipOptOut: true };
    }
    return { kind: "deepgram-inference", descriptor: "deepgram/aura-2" };
  }

  if (XAI.has(provider)) {
    const voice = (env.TTS_VOICE ?? "ara").trim().toLowerCase();
    if (!isXaiVoice(voice)) {
      throw new Error(`Unknown TTS_VOICE "${voice}". xAI voices: ${XAI_VOICES.join(", ")}.`);
    }
    return { kind: "xai-inference", model: "xai/tts-1", voice, descriptor: `xai/tts-1:${voice}` };
  }

  throw new Error(`Unknown TTS_PROVIDER "${provider}". Use deepgram (default) or xai.`);
}
