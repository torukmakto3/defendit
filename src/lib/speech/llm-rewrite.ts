import { getPrimaryLlm, guardRetention, isMockLlm } from "../llm";
import { createLiquidProvider } from "../llm/openai-compat";
import type { LlmProvider } from "../llm/types";
import { recordLlmCall } from "../llm/usage";
import { toSpeakable, type SpeakableResult, type SpeakableRewrite } from "./speakable";

const SYSTEM = [
  "Rewrite this examiner question so it can be read aloud.",
  "Describe a file by its role: a Python or TypeScript file is a script, a JSON file is a file, a spreadsheet is a spreadsheet.",
  "Do not say a file extension, an underscore, or punctuation such as dot, slash, or underscore.",
  "Describe a field in words. A false or off boolean is off. A true or on boolean is on.",
  "Paraphrase code, JSON, and quoted dumps. Do not read them character by character.",
  "Keep the question's meaning, including any lead-in such as the question number.",
  "Return only the spoken question, in one or two sentences. No markdown.",
].join(" ");

/**
 * Model paraphrase for spoken questions. Off unless `SPEECH_REWRITE_LLM=1`,
 * and off in mock mode so an interview never waits on a fake model.
 * `SPEECH_REWRITE_MODEL` pins a Liquid model for this call only; otherwise
 * the primary model is used. The caller caps the wait and falls back to rules.
 */
export function speechLlmRewrite(): SpeakableRewrite | undefined {
  if (process.env.SPEECH_REWRITE_LLM !== "1") return undefined;
  if (isMockLlm()) return undefined;

  const model = process.env.SPEECH_REWRITE_MODEL?.trim();
  const liquidKey = process.env.LIQUID_API_KEY;
  const customLiquid = Boolean(liquidKey && model);
  const provider: LlmProvider =
    liquidKey && model ? guardRetention(createLiquidProvider(liquidKey, model)) : getPrimaryLlm();

  return async (text, signal) => {
    const res = await provider.complete({
      purpose: "speakable_rewrite",
      temperature: 0,
      signal,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    });
    if (customLiquid) {
      await recordLlmCall({
        purpose: "speakable_rewrite",
        provider: res.provider,
        modelId: res.modelId,
        usage: res.usage,
      });
    }
    return res.content.trim();
  };
}

/**
 * Spoken question for the voice interviewer. A missing or failing model
 * leaves the deterministic rules text, still inside the caller's timeout.
 */
export async function prepareSpoken(text: string, timeoutMs = 350): Promise<SpeakableResult> {
  let rewrite: SpeakableRewrite | undefined;
  try {
    rewrite = speechLlmRewrite();
  } catch {
    rewrite = undefined;
  }
  return toSpeakable(text, { rewrite, timeoutMs });
}
