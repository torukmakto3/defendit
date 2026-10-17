export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  json?: boolean;
  /** Label used in receipts / grading council */
  purpose?: string;
}

export interface LlmResponse {
  content: string;
  modelId: string;
  provider: string;
}

export interface LlmProvider {
  id: string;
  provider: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
