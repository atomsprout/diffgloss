import type { ProviderDialect } from "../schema/types.ts";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface LLMResponse {
  text: string;
  usage: LLMUsage;
  model: string;
  provider: ProviderDialect;
}

export interface LLMClientConfig {
  provider: ProviderDialect;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface LLMClient {
  readonly provider: ProviderDialect;
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export interface ModelPricePerMillion {
  input: number;
  output: number;
  cachedInput: number;
}
