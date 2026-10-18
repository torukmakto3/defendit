import { createAnthropicProvider } from "./anthropic";
import { createMockProvider } from "./mock";
import {
  createGroqProvider,
  createOllamaProvider,
  createOpenAICompatProvider,
  createOpenRouterProvider,
} from "./openai-compat";
import { createOpenAIProvider } from "./openai";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

export type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "./types";
export { jevConfigured, jevDecide, mockStakesDecision } from "./jev";

function hasAnyLiveKey(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OLLAMA_BASE_URL ||
      process.env.OPENAI_COMPAT_BASE_URL,
  );
}

export function useMockLlm(): boolean {
  if (process.env.MOCK_LLM === "1" || process.env.MOCK_LLM === "true") {
    return true;
  }
  if (process.env.MOCK_LLM === "0" || process.env.MOCK_LLM === "false") {
    return !hasAnyLiveKey();
  }
  return !hasAnyLiveKey();
}

function preferProvider(): string {
  return (process.env.LLM_PROVIDER || "").toLowerCase();
}

/** Primary model for claim extraction, coaching, and follow-ups. */
export function getPrimaryLlm(): LlmProvider {
  if (useMockLlm()) return createMockProvider("mock-defend-v1");

  const prefer = preferProvider();

  if (prefer === "ollama" || process.env.OLLAMA_BASE_URL) {
    if (prefer === "ollama" || !prefer) return createOllamaProvider();
  }
  if (
    prefer === "groq" ||
    (process.env.GROQ_API_KEY && !prefer)
  ) {
    if (prefer === "groq" || (!prefer && process.env.GROQ_API_KEY)) {
      return createGroqProvider(process.env.GROQ_API_KEY!);
    }
  }
  if (prefer === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return createOpenRouterProvider(process.env.OPENROUTER_API_KEY);
  }
  if (process.env.OPENAI_COMPAT_BASE_URL) {
    return createOpenAICompatProvider({
      id: process.env.OPENAI_COMPAT_MODEL || "compat-model",
      provider: "openai-compat",
      apiKey: process.env.OPENAI_COMPAT_API_KEY,
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL,
      model: process.env.OPENAI_COMPAT_MODEL || "local-model",
    });
  }
  if (process.env.GROQ_API_KEY) {
    return createGroqProvider(process.env.GROQ_API_KEY);
  }
  if (process.env.OPENROUTER_API_KEY) {
    return createOpenRouterProvider(process.env.OPENROUTER_API_KEY);
  }
  if (process.env.OPENAI_API_KEY) {
    return createOpenAIProvider(process.env.OPENAI_API_KEY);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider(process.env.ANTHROPIC_API_KEY);
  }
  return createMockProvider("mock-defend-v1");
}

/**
 * Grading council: several models from different providers when keys exist.
 * Prefers open-weight hosts (Groq / OpenRouter / Ollama) for a cheap beta.
 */
export function getGradingCouncil(): LlmProvider[] {
  if (useMockLlm()) {
    return [
      createMockProvider("mock-council-balanced"),
      createMockProvider("mock-council-strict"),
      createMockProvider("mock-council-lenient"),
    ];
  }

  const council: LlmProvider[] = [];
  const seen = new Set<string>();

  const add = (p: LlmProvider) => {
    const key = `${p.provider}:${p.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    council.push(p);
  };

  if (process.env.GROQ_API_KEY) {
    add(createGroqProvider(process.env.GROQ_API_KEY));
    if (process.env.GROQ_MODEL_B) {
      add(createGroqProvider(process.env.GROQ_API_KEY, process.env.GROQ_MODEL_B));
    }
  }
  if (process.env.OPENROUTER_API_KEY) {
    add(createOpenRouterProvider(process.env.OPENROUTER_API_KEY));
    if (process.env.OPENROUTER_MODEL_B) {
      add(
        createOpenRouterProvider(
          process.env.OPENROUTER_API_KEY,
          process.env.OPENROUTER_MODEL_B,
        ),
      );
    }
  }
  if (process.env.OLLAMA_BASE_URL || preferProvider() === "ollama") {
    add(createOllamaProvider());
    if (process.env.OLLAMA_MODEL_B) {
      add(createOllamaProvider(process.env.OLLAMA_MODEL_B));
    }
  }
  if (process.env.OPENAI_API_KEY) {
    add(createOpenAIProvider(process.env.OPENAI_API_KEY));
  }
  if (process.env.ANTHROPIC_API_KEY) {
    add(createAnthropicProvider(process.env.ANTHROPIC_API_KEY));
  }

  if (council.length === 0) {
    return [
      createMockProvider("mock-council-balanced"),
      createMockProvider("mock-council-strict"),
    ];
  }
  if (council.length === 1) {
    council.push(createMockProvider("mock-council-compare"));
  }
  return council.slice(0, 3);
}

export async function completeJson<T>(
  provider: LlmProvider,
  req: Omit<LlmRequest, "json">,
): Promise<{ data: T; raw: LlmResponse }> {
  const raw = await provider.complete({ ...req, json: true });
  try {
    return { data: JSON.parse(raw.content) as T, raw };
  } catch {
    throw new Error(
      `LLM ${provider.id} returned non-JSON: ${raw.content.slice(0, 200)}`,
    );
  }
}

export function llmModeLabel(): string {
  if (useMockLlm()) return "mock (offline)";
  return `live (${getPrimaryLlm().provider}:${getPrimaryLlm().id})`;
}
