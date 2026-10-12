export interface ToolboxResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
  /** What each device presented, when the call was pinned ("tls:<host>:<port>" → fingerprint). */
  seen?: Record<string, string>;
}

/** Pins this call's devices must match (trust on first use), and whether every certificate must be trusted. */
export interface DeviceTrust {
  pins?: Record<string, string>;
  verifyTls?: boolean;
}

export interface ToolboxClient {
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal, trust?: DeviceTrust): Promise<ToolboxResponse>;
}

export class HttpToolboxClient implements ToolboxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal, trust?: DeviceTrust): Promise<ToolboxResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/tools/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ args, ...trust }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]) : AbortSignal.timeout(20 * 60_000),
    });
    if (res.status === 401) throw new Error("Toolbox rejected the gate's token");
    const body = (await res.json()) as ToolboxResponse;
    return res.ok ? body : { ok: false, error: body.error ?? `toolbox HTTP ${res.status}`, durationMs: body.durationMs, seen: body.seen };
  }
}
