import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  RetentionClass,
} from "./types";
import { usageFromProviderBody } from "./usage";

/**
 * OpenAI-compatible Chat Completions client.
 * Works with Liquid Inference, OpenRouter, Ollama, vLLM, Groq, LM Studio, etc.
 *
 * Never put prompt text or model output in thrown errors or logs: deliverables
 * are confidential and errors travel to clients and log drains.
 */
export function createOpenAICompatProvider(opts: {
  id: string;
  provider: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  retention: RetentionClass;
  /** Merged into every request body (privacy rules, routing). */
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}): LlmProvider {
  const base = opts.baseUrl.replace(/\/$/, "");
  return {
    id: opts.id || opts.model,
    provider: opts.provider,
    retention: opts.retention,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...opts.extraHeaders,
      };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        // Below the 60s route budget, so a slow model fails cleanly instead of the function being killed.
        signal: req.signal ?? AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || "45000")),
        body: JSON.stringify({
          model: opts.model,
          temperature: req.temperature ?? 0.3,
          seed: req.seed,
          response_format: req.json ? { type: "json_object" } : undefined,
          messages: req.messages,
          ...opts.extraBody,
        }),
      });
      if (!res.ok) {
        throw new Error(
          `${opts.provider} error ${res.status}: ${await safeErrorCode(res)}`,
        );
      }
      const data = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string } }[];
        usage?: unknown;
        exchange?: unknown;
        cost?: unknown;
        cost_usd?: unknown;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      return {
        content,
        modelId: data.model || opts.model,
        provider: opts.provider,
        usage: usageFromProviderBody(data, {
          promptText: req.messages.map((message) => message.content).join("\n"),
          completionText: content,
        }),
      };
    },
  };
}

/** Pull only a machine-readable error code from a provider error body. */
async function safeErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string | number; type?: string } | string;
      code?: string;
    };
    if (typeof body.error === "object" && body.error) {
      return String(body.error.code || body.error.type || "unknown");
    }
    return String(body.code || "unknown");
  } catch {
    return "unknown";
  }
}

/** A base-URL override pointing elsewhere loses the vendor's retention guarantee. */
function vendorRetention(baseUrl: string, vendorHost: string): RetentionClass {
  try {
    return new URL(baseUrl).hostname === vendorHost ? "zero-enforced" : "unverified";
  } catch {
    return "unverified";
  }
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    );
  } catch {
    return false;
  }
}

/**
 * Pinned Liquid models for a grading council. These are served model names
 * from the exchange catalog (Oct 2026), not routers: each accepts JSON mode
 * and a seed, and each is a different family so a median and a disagreement
 * can exist. `liquid.auto` and any `*.auto` name pick a model per request.
 */
export const DEFAULT_LIQUID_COUNCIL_MODELS = [
  "gpt-oss-120b",
  "deepseek-v3.2",
  "llama-3.3-70b-instruct",
] as const;

/**
 * Liquid Inference exchange. Every call is restricted to providers that agree
 * not to retain the prompt (`retention_policy: none`) and hold the listed
 * provider claims; a request no provider can meet fails instead of running on
 * a weaker one. The body rule and the header are both sent because the docs
 * disagree on whether `none` is the default.
 */
export function createLiquidProvider(
  apiKey: string,
  model = process.env.LIQUID_MODEL || "liquid.auto",
): LlmProvider {
  const claims = (process.env.LIQUID_REQUIRE_CLAIMS || "zero_retention")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const capUsd = Number(process.env.LIQUID_CAP_USD || "0.05");
  const baseUrl = process.env.LIQUID_BASE_URL || "https://router.inference.ai.exchange/v1";
  return createOpenAICompatProvider({
    id: model,
    provider: "liquid",
    apiKey,
    baseUrl,
    model,
    retention: vendorRetention(baseUrl, "router.inference.ai.exchange"),
    extraHeaders: {
      "x-liquid-retention": "none",
      "x-liquid-tag": process.env.LIQUID_TAG || "defend-it",
    },
    extraBody: {
      exchange: {
        retention_policy: "none",
        provider_requirements: {
          require: claims,
          // Reviewer-checked claims only: strongest, but the pool is thin (27-87s
          // per call when measured Oct 2026), so it is an opt-in tier.
          checked_only: process.env.LIQUID_CHECKED_ONLY === "1",
        },
        cap_usd: Number.isFinite(capUsd) && capUsd > 0 ? capUsd : 0.05,
      },
    },
  });
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
    retention: isLocalUrl(baseUrl) ? "local" : "unverified",
    // Ollama usually ignores the key; some setups expect any string
    apiKey: process.env.OLLAMA_API_KEY || "ollama",
  });
}

export function createCompatProviderFromEnv(modelOverride?: string): LlmProvider {
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL!;
  const override = modelOverride?.trim();
  return createOpenAICompatProvider({
    id: override || process.env.OPENAI_COMPAT_MODEL || "compat-model",
    provider: "openai-compat",
    apiKey: process.env.OPENAI_COMPAT_API_KEY,
    baseUrl,
    model: override || process.env.OPENAI_COMPAT_MODEL || "local-model",
    retention: isLocalUrl(baseUrl) ? "local" : "unverified",
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
    retention: "unverified",
  });
}

/** OpenRouter restricted to zero-data-retention endpoints that don't collect data. */
export function createOpenRouterProvider(
  apiKey: string,
  model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct",
): LlmProvider {
  const baseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  return createOpenAICompatProvider({
    id: model,
    provider: "openrouter",
    apiKey,
    baseUrl,
    model,
    retention: vendorRetention(baseUrl, "openrouter.ai"),
    extraBody: {
      provider: { zdr: true, data_collection: "deny" },
    },
  });
}
