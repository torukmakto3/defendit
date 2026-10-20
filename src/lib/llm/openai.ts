import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

export function createOpenAIProvider(
  apiKey: string,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
): LlmProvider {
  return {
    id: model,
    provider: "openai",
    retention: "unverified",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: req.signal,
        body: JSON.stringify({
          model,
          temperature: req.temperature ?? 0.3,
          response_format: req.json ? { type: "json_object" } : undefined,
          messages: req.messages,
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI error ${res.status}`);
      }
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      return {
        content: data.choices[0]?.message?.content ?? "",
        modelId: model,
        provider: "openai",
      };
    },
  };
}
