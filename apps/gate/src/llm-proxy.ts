// LLM proxy: the worker talks to model providers through the gate, which injects the
// provider's API key (decrypted here, never sent to the worker) and only forwards requests
// to an allowlist of inference endpoints.
import { decryptSecret } from "@moss/core";
import { providers, secrets, type Database } from "@moss/db";
import { eq } from "drizzle-orm";

const DEFAULT_BASE_URLS: Record<string, string | undefined> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/** Paths (relative to the provider base URL) the worker may call. */
const ALLOWED_PATHS: Record<string, RegExp> = {
  anthropic: /^v1\/(messages|messages\/count_tokens|models(\/[\w.-]+)?)$/,
  openai_compatible: /^(chat\/completions|models)$/,
};

/** Request headers forwarded to the provider; everything else (including auth) is dropped. */
const FORWARDED_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

export interface ProxyRequest {
  providerId: string;
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | string | null;
}

export function createLlmProxy(deps: { db: Database; masterKey: Buffer; fetch?: typeof fetch }) {
  const doFetch = deps.fetch ?? fetch;

  return async function proxy(req: ProxyRequest): Promise<ProxyResponse> {
    const error = (status: number, message: string): ProxyResponse => ({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { type: "moss_gate_error", message } }),
    });

    const [provider] = await deps.db.select().from(providers).where(eq(providers.id, req.providerId));
    if (!provider || !provider.enabled) return error(404, "Unknown or disabled provider");

    const family = provider.kind === "anthropic" ? "anthropic" : "openai_compatible";
    if (!ALLOWED_PATHS[family]!.test(req.path)) return error(403, `Path /${req.path} is not an allowed inference endpoint`);
    if (!["GET", "POST"].includes(req.method)) return error(405, "Method not allowed");

    const base = (provider.baseUrl ?? DEFAULT_BASE_URLS[provider.kind])?.replace(/\/+$/, "");
    if (!base) return error(400, "This provider needs a base URL");

    let apiKey: string | undefined;
    if (provider.apiKeySecretId) {
      const [secret] = await deps.db.select().from(secrets).where(eq(secrets.id, provider.apiKeySecretId));
      if (!secret || secret.orgId !== provider.orgId) return error(500, "Provider API key secret is missing");
      apiKey = decryptSecret(deps.masterKey, secret.id, secret);
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") headers[name] = v;
    }
    if (apiKey) {
      if (family === "anthropic") headers["x-api-key"] = apiKey;
      else headers.authorization = `Bearer ${apiKey}`;
    }

    const res = await doFetch(`${base}/${req.path}`, {
      method: req.method,
      headers,
      body: req.method === "POST" && req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(30 * 60_000),
    });
    const outHeaders: Record<string, string> = {};
    for (const name of ["content-type", "request-id", "retry-after", "anthropic-ratelimit-requests-remaining"]) {
      const v = res.headers.get(name);
      if (v) outHeaders[name] = v;
    }
    return { status: res.status, headers: outHeaders, body: res.body };
  };
}

export type LlmProxy = ReturnType<typeof createLlmProxy>;
