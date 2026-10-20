export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  /** Integer seed sent with the call so a stored grade can be reproduced. */
  seed?: number;
  json?: boolean;
  /** Label used in receipts / grading council */
  purpose?: string;
  /** Aborts the HTTP call when the structured-output deadline fires. */
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string;
  modelId: string;
  provider: string;
}

/**
 * How a provider treats the prompt after answering.
 * - zero-enforced: every call carries a rule the host must honour (Liquid, OpenRouter ZDR)
 * - local: runs on a machine we control (Ollama / localhost)
 * - unverified: we cannot enforce retention; refused unless explicitly allowed
 * - mock: offline deterministic models
 */
export type RetentionClass = "zero-enforced" | "local" | "unverified" | "mock";

export interface LlmProvider {
  id: string;
  provider: string;
  retention: RetentionClass;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
