// Single sign-on, the gate's part: exchange the code the browser brought back for an ID token (through the toolbox,
// with the client secret only the gate can read), then check the token against the provider's published keys, which
// the gate fetches itself: the toolbox, which brought the token, must not also choose the keys that check it.
// The web app gets back who it's for, and matches them to a MOSS user itself.
import { SSO_NAMES, SsoError, ssoAvailable, ssoKeysUrl, verifyIdToken, writeAudit, type SsoClaims, type SsoProvider } from "@moss/core";
import type { JsonWebKey } from "node:crypto";
import { systemToolCall, type SystemCallDeps } from "./system-call.js";

/** Providers' signing keys, kept an hour (they change rarely; an unknown key id fetches them again). */
const keyCache = new Map<string, { at: number; keys: { keys?: JsonWebKey[] } }>();

export type SsoExchangeResult = { ok: true; claims: SsoClaims } | { ok: false; error: string };

export async function ssoExchange(
  deps: SystemCallDeps & { fetch?: typeof fetch },
  req: { orgId: string; provider: SsoProvider; code: string; redirectUri: string; codeVerifier: string },
  now = new Date(),
): Promise<SsoExchangeResult> {
  const name = SSO_NAMES[req.provider];
  const setup = await ssoAvailable(deps.db, req.orgId, req.provider);
  if (!setup) return { ok: false, error: `Signing in with ${name} isn't switched on` };
  const { client } = setup;
  const fail = async (error: string) => {
    await writeAudit(deps.db, { orgId: req.orgId, actorType: "system", actorId: null, action: "auth.sso_failed", targetType: "module", targetId: req.provider, details: { error } });
    return { ok: false as const, error };
  };

  const exchanged = await systemToolCall(deps, {
    orgId: req.orgId,
    tool: "oidc_exchange",
    args: { provider: req.provider, ...(client.tenantId ? { tenantId: client.tenantId } : {}), clientId: client.clientId, clientSecret: `secret:${setup.secretName}`, code: req.code, redirectUri: req.redirectUri, codeVerifier: req.codeVerifier },
    secret: { name: setup.secretName, arg: "clientSecret" },
    label: `Signing in with ${name}`,
  });
  if (!exchanged.ok) return fail(exchanged.error);
  const idToken = (exchanged.result as { idToken?: string }).idToken;
  if (!idToken) return fail(`${name} sent no sign-in token`);

  const cacheKey = `${req.provider}:${client.tenantId ?? ""}`;
  const fetchKeys = async () => {
    const res = await (deps.fetch ?? fetch)(ssoKeysUrl(client), { signal: AbortSignal.timeout(10_000) });
    if (res.status !== 200) throw new SsoError(`Couldn't fetch ${name}'s signing keys (HTTP ${res.status})`);
    const body = (await res.json()) as { keys?: unknown };
    const keys = { keys: Array.isArray(body.keys) ? (body.keys.slice(0, 50) as JsonWebKey[]) : [] };
    keyCache.set(cacheKey, { at: now.getTime(), keys });
    return keys;
  };
  try {
    const cached = keyCache.get(cacheKey);
    let keys = cached && now.getTime() - cached.at < 3_600_000 ? cached.keys : await fetchKeys();
    try {
      return { ok: true, claims: verifyIdToken(idToken, keys, client, now) };
    } catch (err) {
      // The provider may have rolled its keys since they were fetched: try once more with fresh ones.
      if (!(err instanceof SsoError) || !/doesn't publish/.test(err.message) || !cached) throw err;
      keys = await fetchKeys();
      return { ok: true, claims: verifyIdToken(idToken, keys, client, now) };
    }
  } catch (err) {
    return fail(err instanceof SsoError ? err.message : `Couldn't check the sign-in: ${(err as Error).message}`);
  }
}
