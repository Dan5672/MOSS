export interface ToolboxResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ToolboxClient {
  call(tool: string, args: Record<string, unknown>): Promise<ToolboxResponse>;
}

export class HttpToolboxClient implements ToolboxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async call(tool: string, args: Record<string, unknown>): Promise<ToolboxResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/tools/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (res.status === 401) throw new Error("Toolbox rejected the gate's token");
    const body = (await res.json()) as ToolboxResponse;
    return res.ok ? body : { ok: false, error: body.error ?? `toolbox HTTP ${res.status}`, durationMs: body.durationMs };
  }
}
