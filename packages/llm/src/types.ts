// Provider-neutral interfaces for the MOSS agent runtime.
//
// A ChatSession owns the provider-native transcript and only ever appends to it.
// That keeps provider-specific content (e.g. Claude thinking blocks, which must be
// replayed unchanged) intact without the agent loop having to understand it.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (type: "object"). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/** Token usage for one model invocation. A turn served by a fallback model has several entries. */
export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "context_exceeded" | "other";

export interface TurnResult {
  text: string;
  toolCalls: ToolCallRequest[];
  stopReason: StopReason;
  /** Refusal category or other provider detail, when available. */
  stopDetail?: string;
  /** Model that produced the final output (may differ from the requested model after a fallback). */
  servedModel: string;
  usage: UsageEntry[];
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionOptions {
  model: string;
  system: string;
  tools: ToolSpec[];
  maxOutputTokens?: number;
  effort?: Effort;
}

export type TurnInput = { text: string } | { toolResults: ToolResult[] };

export interface ChatSession {
  send(input: TurnInput): Promise<TurnResult>;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
}

/**
 * "claude_code" runs agents through the Claude Code CLI on the owner's Claude subscription.
 * It has no completion adapter: the agent runtime drives the CLI itself.
 */
export type ProviderKind = "anthropic" | "openai" | "openrouter" | "ollama" | "openai_compatible" | "claude_code";

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  startSession(opts: SessionOptions): ChatSession;
  listModels(): Promise<ModelInfo[]>;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
