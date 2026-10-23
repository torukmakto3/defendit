/**
 * Which voice speaks the scripted interview.
 *
 * English is unchanged. Deepgram Aura-2 Thalia stays the default
 * (`aura-2-thalia-en` with a key, otherwise the LiveKit Inference descriptor
 * `deepgram/aura-2`). `TTS_PROVIDER=xai` still selects xAI Grok TTS through
 * LiveKit Inference (model xai/tts-1). The official xAI plugin is Python-only,
 * so this Node agent does not read XAI_API_KEY.
 *
 * Spanish uses Aura-2 Estrella (`aura-2-estrella-es`, inference voice
 * `estrella`, language `es`) while the provider is Deepgram. Aura-2 has no
 * Portuguese voice, so a Portuguese document is spoken by xAI Ara with
 * language `pt-BR` even when TTS_PROVIDER is deepgram. That path is cheaper
 * than Aura-2 and is already wired. Other non-English documents use the same
 * xAI voice with the document's language code, because Thalia would read them
 * in English.
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
  | { kind: "deepgram-plugin"; model: string; language: string; mipOptOut: true }
  | { kind: "deepgram-inference"; descriptor: "deepgram/aura-2"; voice?: string; language: string }
  | {
      kind: "xai-inference";
      model: "xai/tts-1";
      voice: XaiVoice;
      descriptor: `xai/tts-1:${XaiVoice}`;
      language: string;
      /** Set when Aura-2 cannot speak this document and synthesis moves to xAI. */
      note?: "aura-2-has-no-portuguese" | "aura-2-has-no-voice";
    };

const DEEPGRAM = new Set(["", "deepgram", "aura", "aura-2"]);
const XAI = new Set(["xai", "grok"]);

/** Aura-2 Estrella. Calm, and Deepgram lists Interview among its uses. */
const SPANISH_AURA = { model: "aura-2-estrella-es", voice: "estrella", language: "es" };

function isXaiVoice(value: string): value is XaiVoice {
  return (XAI_VOICES as readonly string[]).includes(value);
}

function primary(language: string | null | undefined): string {
  const code = (language ?? "en").trim().toLowerCase().replace(/_/g, "-").split("-")[0] ?? "";
  return /^[a-z]{2,3}$/.test(code) ? code : "en";
}

/** xAI takes a region tag for Portuguese. Spanish stays the primary subtag. */
export function synthesisLanguage(code: string): string {
  if (code === "pt") return "pt-BR";
  return code;
}

function xaiChoice(
  voice: XaiVoice,
  language: string,
  note?: "aura-2-has-no-portuguese" | "aura-2-has-no-voice",
): TtsChoice {
  return {
    kind: "xai-inference",
    model: "xai/tts-1",
    voice,
    descriptor: `xai/tts-1:${voice}`,
    language,
    ...(note ? { note } : {}),
  };
}

export function selectTts(env: Record<string, string | undefined>, language?: string | null): TtsChoice {
  const provider = (env.TTS_PROVIDER ?? "").trim().toLowerCase();
  const code = primary(language);

  if (DEEPGRAM.has(provider)) {
    if (code === "es") {
      if (env.DEEPGRAM_API_KEY) {
        return { kind: "deepgram-plugin", model: SPANISH_AURA.model, language: "es", mipOptOut: true };
      }
      return { kind: "deepgram-inference", descriptor: "deepgram/aura-2", voice: SPANISH_AURA.voice, language: "es" };
    }
    if (code !== "en") {
      const note = code === "pt" ? "aura-2-has-no-portuguese" : "aura-2-has-no-voice";
      return xaiChoice("ara", synthesisLanguage(code), note);
    }
    if (env.DEEPGRAM_API_KEY) {
      return { kind: "deepgram-plugin", model: "aura-2-thalia-en", language: "en", mipOptOut: true };
    }
    return { kind: "deepgram-inference", descriptor: "deepgram/aura-2", language: "en" };
  }

  if (XAI.has(provider)) {
    const voice = (env.TTS_VOICE ?? "ara").trim().toLowerCase();
    if (!isXaiVoice(voice)) {
      throw new Error(`Unknown TTS_VOICE "${voice}". xAI voices: ${XAI_VOICES.join(", ")}.`);
    }
    return xaiChoice(voice, synthesisLanguage(code));
  }

  throw new Error(`Unknown TTS_PROVIDER "${provider}". Use deepgram (default) or xai.`);
}
