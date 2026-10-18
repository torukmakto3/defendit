import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

export function createAnthropicProvider(
  apiKey: string,
  model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
): LlmProvider {
  return {
    id: model,
    provider: "anthropic",
    retention: "unverified",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const system = req.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const messages = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        }));

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: req.temperature ?? 0.3,
          system: system || undefined,
          messages,
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic error ${res.status}`);
      }
      const data = (await res.json()) as {
        content: { type: string; text?: string }[];
      };
      const content = data.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");
      return { content, modelId: model, provider: "anthropic" };
    },
  };
}
