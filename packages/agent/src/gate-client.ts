// Client for the gate service: lists an agent's network tools and submits tool calls for policy checks.
export interface GateToolSpec {
  name: string;
  class: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type GateToolResponse =
  | { allowed: true; ok: boolean; result?: unknown; error?: string; durationMs?: number }
  | { allowed: false; code: string; reason: string };

export interface GateClient {
  listTools(agentId: string): Promise<GateToolSpec[]>;
  callTool(req: { agentId: string; tool: string; args: unknown; changeId?: string; runId?: string }): Promise<GateToolResponse>;
}

export class HttpGateClient implements GateClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25 * 60_000),
    });
    if (!res.ok) throw new Error(`Gate returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async listTools(agentId: string) {
    return (await this.request<{ tools: GateToolSpec[] }>(`/v1/agents/${agentId}/tools`)).tools;
  }

  callTool(req: Parameters<GateClient["callTool"]>[0]) {
    return this.request<GateToolResponse>("/v1/tool-calls", req);
  }
}
