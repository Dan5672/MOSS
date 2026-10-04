// Adapter for the OpenAI Chat Completions wire format, which OpenAI, OpenRouter,
// Ollama (/v1) and most self-hosted gateways speak.
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ChatSession,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderKind,
  type SessionOptions,
  type StopReason,
  type TurnInput,
  type TurnResult,
} from "./types.js";

const DEFAULT_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

export interface OpenAICompatibleOptions {
  kind: Exclude<ProviderKind, "anthropic">;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface WireResponse {
  model?: string;
  choices: { message: { content: string | null; tool_calls?: WireToolCall[]; refusal?: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Provider returned HTTP ${status}: ${body.slice(0, 500)}`);
  }
  get retryable() {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

function mapFinish(reason: string, refusal: unknown): StopReason {
  if (refusal) return "refusal";
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

/** Tool arguments arrive as a JSON string; a malformed one is surfaced to the agent rather than thrown. */
function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { __invalid_json: raw };
  }
}

class OpenAICompatibleSession implements ChatSession {
  private readonly messages: WireMessage[];

  constructor(
    private readonly adapter: OpenAICompatibleAdapter,
    private readonly opts: SessionOptions,
  ) {
    this.messages = [{ role: "system", content: opts.system }];
  }

  async send(input: TurnInput): Promise<TurnResult> {
    if ("text" in input) this.messages.push({ role: "user", content: input.text });
    else for (const r of input.toolResults) {
      this.messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
    }

    const body = {
      model: this.opts.model,
      messages: this.messages,
      max_tokens: this.opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(this.opts.tools.length > 0
        ? {
            tools: this.opts.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };
    const res = await this.adapter.request<WireResponse>("/chat/completions", body);
    const choice = res.choices[0];
    if (!choice) throw new Error("Provider returned no choices");

    const msg = choice.message;
    this.messages.push({ role: "assistant", content: msg.content, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });

    const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const servedModel = res.model ?? this.opts.model;
    return {
      text: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })),
      stopReason: mapFinish(choice.finish_reason, msg.refusal),
      stopDetail: msg.refusal ?? undefined,
      servedModel,
      usage: [
        {
          model: servedModel,
          inputTokens: (res.usage?.prompt_tokens ?? 0) - cached,
          outputTokens: res.usage?.completion_tokens ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        },
      ],
    };
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  private readonly baseURL: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.kind = options.kind;
    const base = options.baseURL ?? DEFAULT_BASE_URLS[options.kind];
    if (!base) throw new Error(`A base URL is required for provider kind ${options.kind}`);
    this.baseURL = base.replace(/\/+$/, "");
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const doFetch = this.options.fetch ?? fetch;
    const res = await doFetch(`${this.baseURL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 600_000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, await res.text());
    return (await res.json()) as T;
  }

  startSession(opts: SessionOptions): ChatSession {
    return new OpenAICompatibleSession(this, opts);
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.request<{ data: { id: string; name?: string; context_length?: number }[] }>("/models");
    return res.data.map((m) => ({ id: m.id, displayName: m.name ?? m.id, contextWindow: m.context_length }));
  }
}
