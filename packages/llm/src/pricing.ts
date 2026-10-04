// Token pricing (USD per million tokens). Users can edit prices per model in the UI;
// this table seeds known models and prices fallback models the user never configured.
import type { UsageEntry } from "./types.js";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Anthropic first-party prices (as of 2026-09). Cache writes are 1.25x input for 5-minute caching. */
export const KNOWN_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export type PricingLookup = (model: string) => ModelPricing | undefined;

export function costOf(entry: UsageEntry, pricing: ModelPricing): number {
  return (
    (entry.inputTokens * pricing.input +
      entry.outputTokens * pricing.output +
      entry.cacheReadTokens * pricing.cacheRead +
      entry.cacheWriteTokens * pricing.cacheWrite) /
    1_000_000
  );
}

/** Prices each entry by the model that actually served it. Unknown models (e.g. local Ollama) cost 0. */
export function priceUsage(usage: UsageEntry[], lookup: PricingLookup): { costUsd: number; unpricedModels: string[] } {
  let costUsd = 0;
  const unpriced = new Set<string>();
  for (const entry of usage) {
    const pricing = lookup(entry.model) ?? KNOWN_PRICING[entry.model];
    if (pricing) costUsd += costOf(entry, pricing);
    else unpriced.add(entry.model);
  }
  return { costUsd, unpricedModels: [...unpriced] };
}

export function totalTokens(usage: UsageEntry[]): number {
  return usage.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0);
}
