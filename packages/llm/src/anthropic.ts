// Claude adapter, built on the official Anthropic SDK.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ChatSession,
  type ModelInfo,
  type ProviderAdapter,
  type SessionOptions,
  type StopReason,
  type TurnInput,
  type TurnResult,
  type UsageEntry,
} from "./types.js";

/** Models that accept the server-side refusal fallback in its "default" routing form. */
const DEFAULT_FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Bounds the server-tool continuation loop so a misbehaving turn can't spin forever. */
const MAX_PAUSE_CONTINUATIONS = 5;

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseURL?: string;
  /** Re-run refused requests on a fallback model (on by default where supported). */
  refusalFallback?: boolean;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
}

function mapStopReason(reason: BetaMessage["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "model_context_window_exceeded":
      return "context_exceeded";
    default:
      return "other";
  }
}

export function usageFromMessage(message: BetaMessage): UsageEntry[] {
  const iterations = message.usage.iterations ?? [];
  if (iterations.length > 0) {
    return iterations.map((it) => ({
      model: ("model" in it && it.model) || message.model,
      inputTokens: it.input_tokens,
      outputTokens: it.output_tokens,
      cacheReadTokens: it.cache_read_input_tokens ?? 0,
      cacheWriteTokens: it.cache_creation_input_tokens ?? 0,
    }));
  }
  const u = message.usage;
  return [
    {
      model: message.model,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  ];
}

class AnthropicSession implements ChatSession {
  private readonly messages: BetaMessageParam[] = [];
  private readonly tools: BetaTool[];

  constructor(
    private readonly client: Anthropic,
    private readonly opts: SessionOptions,
    private readonly useFallback: boolean,
  ) {
    this.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool["input_schema"],
    }));
  }

  async send(input: TurnInput): Promise<TurnResult> {
    this.messages.push(
      "text" in input
        ? { role: "user", content: input.text }
        : {
            role: "user",
            content: input.toolResults.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id,
              content: r.content,
              is_error: r.isError ?? false,
            })),
          },
    );

    const usage: UsageEntry[] = [];
    for (let i = 0; ; i++) {
      const response = await this.client.beta.messages.create({
        model: this.opts.model,
        max_tokens: this.opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        system: this.opts.system,
        tools: this.tools.length > 0 ? this.tools : undefined,
        messages: this.messages,
        // Caches the stable prefix (tools + system + history) across the agent loop.
        cache_control: { type: "ephemeral" },
        ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
        ...(this.useFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      });
      usage.push(...usageFromMessage(response));
      // Append the full content unchanged: thinking and fallback blocks must be replayed as-is.
      this.messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "pause_turn" && i < MAX_PAUSE_CONTINUATIONS) continue;

      const toolCalls = response.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      return {
        text,
        toolCalls,
        stopReason: mapStopReason(response.stop_reason),
        stopDetail: response.stop_details?.category ?? undefined,
        servedModel: response.model,
        usage,
      };
    }
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicAdapterOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, fetch: options.fetch });
  }

  startSession(opts: SessionOptions): ChatSession {
    const useFallback = (this.options.refusalFallback ?? true) && DEFAULT_FALLBACK_MODELS.has(opts.model);
    return new AnthropicSession(this.client, opts, useFallback);
  }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    for await (const m of this.client.models.list()) {
      out.push({ id: m.id, displayName: m.display_name, contextWindow: m.max_input_tokens ?? undefined });
    }
    return out;
  }
}
