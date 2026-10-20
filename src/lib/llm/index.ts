import { createAnthropicProvider } from "./anthropic";
import { createMockProvider } from "./mock";
import {
  createCompatProviderFromEnv,
  createGroqProvider,
  createLiquidProvider,
  createOllamaProvider,
  createOpenRouterProvider,
} from "./openai-compat";
import { createOpenAIProvider } from "./openai";
import { isDeployed } from "../secrets";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

export type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  RetentionClass,
} from "./types";
export { jevConfigured, jevDecide, mockStakesDecision } from "./jev";

function hasAnyLiveKey(): boolean {
  return Boolean(
    process.env.LIQUID_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OLLAMA_BASE_URL ||
      process.env.OPENAI_COMPAT_BASE_URL,
  );
}

export function isMockLlm(): boolean {
  if (process.env.MOCK_LLM === "1" || process.env.MOCK_LLM === "true") {
    return true;
  }
  if (hasAnyLiveKey()) return false;
  // A deployment with no model configured must not sign mock-graded receipts.
  if (isDeployed()) {
    throw new Error(
      "No LLM provider is configured. Set LIQUID_API_KEY (or another provider), or MOCK_LLM=1 for a test deployment.",
    );
  }
  return true;
}

function preferProvider(): string {
  return (process.env.LLM_PROVIDER || "").toLowerCase();
}

/**
 * Deliverables are confidential. A live call only goes out when the provider
 * enforces zero retention per request or runs locally; anything else needs an
 * explicit operator opt-in.
 */
export function guardRetention(provider: LlmProvider): LlmProvider {
  if (provider.retention !== "unverified") return provider;
  return {
    ...provider,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      if (process.env.LLM_ALLOW_UNVERIFIED_RETENTION !== "1") {
        throw new Error(
          `LLM provider "${provider.provider}" cannot enforce zero data retention. ` +
            "Use Liquid Inference, OpenRouter (ZDR) or a local model, or set " +
            "LLM_ALLOW_UNVERIFIED_RETENTION=1 to accept the risk.",
        );
      }
      return provider.complete(req);
    },
  };
}

function selectPrimary(): LlmProvider {
  if (isMockLlm()) return createMockProvider("mock-defend-v1");

  const env = process.env;
  switch (preferProvider()) {
    case "liquid":
      if (env.LIQUID_API_KEY) return createLiquidProvider(env.LIQUID_API_KEY);
      break;
    case "openrouter":
      if (env.OPENROUTER_API_KEY) {
        return createOpenRouterProvider(env.OPENROUTER_API_KEY);
      }
      break;
    case "ollama":
      return createOllamaProvider();
    case "groq":
      if (env.GROQ_API_KEY) return createGroqProvider(env.GROQ_API_KEY);
      break;
    case "openai-compat":
      if (env.OPENAI_COMPAT_BASE_URL) return createCompatProviderFromEnv();
      break;
  }

  // Default order: privacy-enforcing hosts first, then local, then the rest.
  if (env.LIQUID_API_KEY) return createLiquidProvider(env.LIQUID_API_KEY);
  if (env.OPENROUTER_API_KEY) {
    return createOpenRouterProvider(env.OPENROUTER_API_KEY);
  }
  if (env.OLLAMA_BASE_URL) return createOllamaProvider();
  if (env.OPENAI_COMPAT_BASE_URL) return createCompatProviderFromEnv();
  if (env.GROQ_API_KEY) return createGroqProvider(env.GROQ_API_KEY);
  if (env.OPENAI_API_KEY) return createOpenAIProvider(env.OPENAI_API_KEY);
  if (env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider(env.ANTHROPIC_API_KEY);
  }
  return createMockProvider("mock-defend-v1");
}

/** Primary model for claim extraction, coaching, and follow-ups. */
export function getPrimaryLlm(): LlmProvider {
  return guardRetention(selectPrimary());
}

/**
 * Grading council: several models when configured. A live council is never
 * padded with mock models, because their scores would land in real receipts.
 */
export function getGradingCouncil(): LlmProvider[] {
  if (isMockLlm()) {
    return [
      createMockProvider("mock-council-balanced"),
      createMockProvider("mock-council-strict"),
      createMockProvider("mock-council-lenient"),
    ];
  }

  const env = process.env;
  const council: LlmProvider[] = [];
  const seen = new Set<string>();
  const allowUnverified = env.LLM_ALLOW_UNVERIFIED_RETENTION === "1";
  const add = (p: LlmProvider) => {
    const key = `${p.provider}:${p.id}`;
    if (seen.has(key)) return;
    // A leftover key for a retaining provider must not join (and break) the council.
    if (p.retention === "unverified" && !allowUnverified) return;
    seen.add(key);
    council.push(guardRetention(p));
  };

  if (env.LIQUID_API_KEY) {
    const models = (env.LIQUID_COUNCIL_MODELS || env.LIQUID_MODEL || "liquid.auto")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    for (const m of models) add(createLiquidProvider(env.LIQUID_API_KEY, m));
  }
  if (env.OPENROUTER_API_KEY) {
    add(createOpenRouterProvider(env.OPENROUTER_API_KEY));
    if (env.OPENROUTER_MODEL_B) {
      add(createOpenRouterProvider(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL_B));
    }
  }
  if (env.OLLAMA_BASE_URL || preferProvider() === "ollama") {
    add(createOllamaProvider());
    if (env.OLLAMA_MODEL_B) add(createOllamaProvider(env.OLLAMA_MODEL_B));
  }
  if (env.GROQ_API_KEY) {
    add(createGroqProvider(env.GROQ_API_KEY));
    if (env.GROQ_MODEL_B) add(createGroqProvider(env.GROQ_API_KEY, env.GROQ_MODEL_B));
  }
  if (env.OPENAI_API_KEY) add(createOpenAIProvider(env.OPENAI_API_KEY));
  if (env.ANTHROPIC_API_KEY) add(createAnthropicProvider(env.ANTHROPIC_API_KEY));

  if (council.length === 0) council.push(getPrimaryLlm());
  return council.slice(0, 3);
}

export async function completeJson<T>(
  provider: LlmProvider,
  req: Omit<LlmRequest, "json">,
): Promise<{ data: T; raw: LlmResponse }> {
  const raw = await provider.complete({ ...req, json: true });
  try {
    return { data: JSON.parse(stripJsonFence(raw.content)) as T, raw };
  } catch {
    // Model output can quote the confidential document: report length only.
    throw new Error(
      `LLM ${provider.provider}:${provider.id} returned non-JSON (${raw.content.length} chars)`,
    );
  }
}

/** Some hosts wrap JSON mode output in a ```json fence. */
function stripJsonFence(content: string): string {
  const m = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : content;
}

export function llmModeLabel(): string {
  try {
    if (isMockLlm()) return "mock (offline)";
    const p = getPrimaryLlm();
    return `live (${p.provider}:${p.id}, retention ${p.retention})`;
  } catch {
    return "not configured";
  }
}
