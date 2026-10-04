// Scripted provider for deterministic agent tests: each send() returns the next scripted turn.
import type { ChatSession, ModelInfo, ProviderAdapter, SessionOptions, TurnInput, TurnResult } from "./types.js";

export type ScriptedTurn = Partial<Omit<TurnResult, "usage">> & {
  usage?: { inputTokens: number; outputTokens: number };
  /** Optional assertion on what the agent sent for this turn. */
  expect?: (input: TurnInput) => void | Promise<void>;
};

export class MockAdapter implements ProviderAdapter {
  readonly kind = "openai_compatible" as const;
  readonly received: { opts: SessionOptions; inputs: TurnInput[] }[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

  startSession(opts: SessionOptions): ChatSession {
    const log = { opts, inputs: [] as TurnInput[] };
    this.received.push(log);
    return {
      send: async (input) => {
        log.inputs.push(input);
        const turn = this.script.shift();
        if (!turn) throw new Error("MockAdapter script exhausted");
        await turn.expect?.(input);
        const toolCalls = turn.toolCalls ?? [];
        return {
          text: turn.text ?? "",
          toolCalls,
          stopReason: turn.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end"),
          stopDetail: turn.stopDetail,
          servedModel: turn.servedModel ?? opts.model,
          usage: [
            {
              model: turn.servedModel ?? opts.model,
              inputTokens: turn.usage?.inputTokens ?? 100,
              outputTokens: turn.usage?.outputTokens ?? 50,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        };
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", displayName: "Mock Model" }];
  }
}
