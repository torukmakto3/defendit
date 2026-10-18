import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

/**
 * OpenAI-compatible Chat Completions client.
 * Works with Ollama, vLLM, Groq, OpenRouter, LM Studio, etc.
 */
export function createOpenAICompatProvider(opts: {
  id: string;
  provider: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  headers?: Record<string, string>;
}): LlmProvider {
  const base = opts.baseUrl.replace(/\/$/, "");
  return {
    id: opts.id || opts.model,
    provider: opts.provider,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...opts.headers,
      };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: opts.model,
          temperature: req.temperature ?? 0.3,
          response_format: req.json ? { type: "json_object" } : undefined,
          messages: req.messages,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `${opts.provider} error ${res.status}: ${text.slice(0, 400)}`,
        );
      }
      const data = (await res.json()) as {
        model?: string;
        choices: { message: { content: string } }[];
      };
      return {
        content: data.choices[0]?.message?.content ?? "",
        modelId: data.model || opts.model,
        provider: opts.provider,
      };
    },
  };
}

export function createOllamaProvider(
  model = process.env.OLLAMA_MODEL || "llama3.2",
  baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
): LlmProvider {
  return createOpenAICompatProvider({
    id: model,
    provider: "ollama",
    baseUrl,
    model,
    // Ollama usually ignores the key; some setups expect any string
    apiKey: process.env.OLLAMA_API_KEY || "ollama",
  });
}

export function createGroqProvider(
  apiKey: string,
  model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
): LlmProvider {
  return createOpenAICompatProvider({
    id: model,
    provider: "groq",
    apiKey,
    baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    model,
  });
}

export function createOpenRouterProvider(
  apiKey: string,
  model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct",
): LlmProvider {
  return createOpenAICompatProvider({
    id: model,
    provider: "openrouter",
    apiKey,
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    model,
  });
}

const LIQUID_BASE = "https://router.inference.ai.exchange/v1";

/**
 * Architect Liquid Inference. Pin a model id. liquid.auto may swap the
 * deployment, so grading must not use it. Retention none is a hard buyer rule.
 */
export function createLiquidProvider(
  apiKey: string,
  model = process.env.LIQUID_MODEL || "llama-3.3-70b-instruct",
): LlmProvider {
  return createOpenAICompatProvider({
    id: model,
    provider: "liquid",
    apiKey,
    baseUrl: process.env.LIQUID_BASE_URL || LIQUID_BASE,
    model,
    headers: {
      "x-liquid-retention": "none",
      "x-liquid-cap-usd": process.env.LIQUID_CAP_USD || "0.05",
      "x-liquid-tag": "defend-it",
    },
  });
}
