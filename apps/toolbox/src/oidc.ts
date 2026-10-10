// Single sign-on: exchanging the code a provider gave the browser for an ID token, and fetching the provider's
// published signing keys. Only the gate calls these (system tools); it checks the token itself.
import { clean } from "./parsers.js";

export class OidcError extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const endpoints = (provider: "microsoft" | "google", tenantId?: string) =>
  provider === "microsoft"
    ? { token: `https://login.microsoftonline.com/${encodeURIComponent(tenantId ?? "")}/oauth2/v2.0/token`, keys: `https://login.microsoftonline.com/${encodeURIComponent(tenantId ?? "")}/discovery/v2.0/keys` }
    : { token: "https://oauth2.googleapis.com/token", keys: "https://www.googleapis.com/oauth2/v3/certs" };

export async function oidcExchange(
  a: { provider: "microsoft" | "google"; tenantId?: string; clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string; timeoutMs: number },
  f: Fetch = fetch as unknown as Fetch,
) {
  const res = await f(endpoints(a.provider, a.tenantId).token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: a.code,
      redirect_uri: a.redirectUri,
      client_id: a.clientId,
      client_secret: a.clientSecret,
      code_verifier: a.codeVerifier,
      ...(a.provider === "microsoft" ? { scope: "openid email profile" } : {}),
    }).toString(),
    signal: AbortSignal.timeout(a.timeoutMs),
  });
  const body = obj(await res.json().catch(() => ({})));
  if (res.status !== 200 || typeof body.id_token !== "string") {
    throw new OidcError(`The provider refused the sign-in: ${clean(body.error_description)?.split("\r\n")[0] ?? clean(body.error) ?? `HTTP ${res.status}`}`);
  }
  // Only the ID token: the access token isn't needed and isn't kept.
  return { idToken: body.id_token };
}

export async function oidcKeys(a: { provider: "microsoft" | "google"; tenantId?: string; timeoutMs: number }, f: Fetch = fetch as unknown as Fetch) {
  const res = await f(endpoints(a.provider, a.tenantId).keys, { signal: AbortSignal.timeout(a.timeoutMs) });
  if (res.status !== 200) throw new OidcError(`Couldn't fetch the provider's signing keys (HTTP ${res.status})`);
  const keys = obj(await res.json()).keys;
  return { keys: Array.isArray(keys) ? keys.slice(0, 50) : [] };
}
