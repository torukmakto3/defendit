/**
 * Speech-to-text for the scripted interview.
 *
 * English stays Deepgram Nova-3 at en-US. That is the plugin default, and the
 * LiveKit Inference descriptor stays "deepgram/nova-3".
 *
 * Spanish and Portuguese (and the other Nova-3 multilingual languages) use
 * language "multi". Nova-3 multi code-switches across en, es, fr, de, hi, ru,
 * pt, ja, it, and nl, so an answer in the document language or in English is
 * transcribed. The inference descriptor is "deepgram/nova-3:multi".
 *
 * A language outside that set is sent as itself. English answers may then be
 * missed; the worker does not guess a second language for those.
 */

export type SttChoice =
  | {
      kind: "deepgram-plugin";
      model: "nova-3";
      language: string;
      smartFormat: true;
      punctuate: true;
      mipOptOut: true;
    }
  | { kind: "deepgram-inference"; descriptor: string; language: string };

/** Nova-3 streaming languages that code-switch, including English. */
const NOVA3_MULTI = new Set(["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"]);

function primary(language: string | null | undefined): string {
  const code = (language ?? "en").trim().toLowerCase().replace(/_/g, "-").split("-")[0] ?? "";
  return /^[a-z]{2,3}$/.test(code) ? code : "en";
}

export function selectStt(env: Record<string, string | undefined>, language?: string | null): SttChoice {
  const code = primary(language);
  const multilingual = code !== "en" && NOVA3_MULTI.has(code);
  const sttLanguage = code === "en" ? "en-US" : multilingual ? "multi" : code;
  const descriptor = code === "en" ? "deepgram/nova-3" : multilingual ? "deepgram/nova-3:multi" : `deepgram/nova-3:${code}`;
  if (env.DEEPGRAM_API_KEY) {
    return {
      kind: "deepgram-plugin",
      model: "nova-3",
      language: sttLanguage,
      smartFormat: true,
      punctuate: true,
      mipOptOut: true,
    };
  }
  return { kind: "deepgram-inference", descriptor, language: sttLanguage };
}
