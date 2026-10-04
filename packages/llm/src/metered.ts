// Wraps a ChatSession with budget enforcement and usage recording.
// The guard runs before every call; the sink records every call's usage, even failed turns' partial usage.
import { priceUsage, totalTokens, type PricingLookup } from "./pricing.js";
import type { ChatSession, TurnInput, TurnResult, UsageEntry } from "./types.js";

export interface BudgetGuard {
  /** Throws BudgetExceededError (or returns a reason) when the next call must not run. */
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface UsageSink {
  record(entry: { usage: UsageEntry[]; costUsd: number; tokens: number; unpricedModels: string[] }): Promise<void>;
}

export class BudgetExceededError extends Error {
  constructor(reason: string) {
    super(`Budget exceeded: ${reason}`);
  }
}

export class MeteredSession implements ChatSession {
  constructor(
    private readonly inner: ChatSession,
    private readonly guard: BudgetGuard,
    private readonly sink: UsageSink,
    private readonly pricing: PricingLookup,
  ) {}

  async send(input: TurnInput): Promise<TurnResult> {
    const verdict = await this.guard.check();
    if (!verdict.ok) throw new BudgetExceededError(verdict.reason);
    const result = await this.inner.send(input);
    const { costUsd, unpricedModels } = priceUsage(result.usage, this.pricing);
    await this.sink.record({ usage: result.usage, costUsd, tokens: totalTokens(result.usage), unpricedModels });
    return result;
  }
}
