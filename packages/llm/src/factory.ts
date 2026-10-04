import { AnthropicAdapter } from "./anthropic.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import type { ProviderAdapter, ProviderKind } from "./types.js";

export interface ProviderConfig {
  kind: ProviderKind;
  apiKey?: string;
  baseURL?: string;
}

export function createProvider(config: ProviderConfig): ProviderAdapter {
  if (config.kind === "anthropic") {
    if (!config.apiKey) throw new Error("The Anthropic provider requires an API key");
    return new AnthropicAdapter({ apiKey: config.apiKey, baseURL: config.baseURL });
  }
  return new OpenAICompatibleAdapter({ kind: config.kind, apiKey: config.apiKey, baseURL: config.baseURL });
}
