import { createAnthropicProvider } from "./anthropic";
import { createMockProvider } from "./mock";
import { createOpenAIProvider } from "./openai";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

export type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "./types";

export function useMockLlm(): boolean {
  if (process.env.MOCK_LLM === "1" || process.env.MOCK_LLM === "true") {
    return true;
  }
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  return !hasOpenAI && !hasAnthropic;
}

/** Primary model for claim extraction, coaching, and follow-ups. */
export function getPrimaryLlm(): LlmProvider {
  if (useMockLlm()) return createMockProvider("mock-defend-v1");
  if (process.env.OPENAI_API_KEY) {
    return createOpenAIProvider(process.env.OPENAI_API_KEY);
  }
  return createAnthropicProvider(process.env.ANTHROPIC_API_KEY!);
}

/**
 * Grading council: several models from different providers when keys exist.
 * In mock mode, returns three biased mock graders for comparison.
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
  if (process.env.OPENAI_API_KEY) {
    council.push(createOpenAIProvider(process.env.OPENAI_API_KEY));
  }
  if (process.env.ANTHROPIC_API_KEY) {
    council.push(createAnthropicProvider(process.env.ANTHROPIC_API_KEY));
  }
  if (council.length === 0) {
    return getGradingCouncilMockFallback();
  }
  if (council.length === 1) {
    // Duplicate with a second mock for comparison UI during partial setup
    council.push(createMockProvider("mock-council-compare"));
  }
  return council;
}

function getGradingCouncilMockFallback(): LlmProvider[] {
  return [
    createMockProvider("mock-council-balanced"),
    createMockProvider("mock-council-strict"),
  ];
}

export async function completeJson<T>(
  provider: LlmProvider,
  req: Omit<LlmRequest, "json">,
): Promise<{ data: T; raw: LlmResponse }> {
  const raw = await provider.complete({ ...req, json: true });
  try {
    return { data: JSON.parse(raw.content) as T, raw };
  } catch {
    throw new Error(`LLM ${provider.id} returned non-JSON: ${raw.content.slice(0, 200)}`);
  }
}

export function llmModeLabel(): string {
  return useMockLlm() ? "mock (offline)" : "live providers";
}
