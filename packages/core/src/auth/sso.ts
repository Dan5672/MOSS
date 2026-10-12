// Single sign-on with Microsoft (Entra ID) and Google, by OpenID Connect: the authorization code flow with PKCE.
// The web app sends the browser to the provider and back; the gate exchanges the code (through the toolbox, the
// only way out to the internet) and checks the ID token here: its signature against the provider's published keys,
// issuer, audience, expiry, and for Microsoft the tenant, for Google a verified email in an allowed domain. Only
// people already in MOSS can sign in this way, matched by email the first time and by their provider id after.
import { users, type Database } from "@moss/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { loadIntegration } from "../integrations/config.js";
import { getIntegration } from "../integrations/registry.js";
import type { IntegrationConfig } from "../integrations/types.js";
import { integrationLicensed } from "../licensing/service.js";
import { writeAudit } from "../store/audit-store.js";

export const SSO_PROVIDERS = ["microsoft", "google"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];
export const SSO_NAMES: Record<SsoProvider, string> = { microsoft: "Microsoft", google: "Google" };
/** The integration each provider's sign-in belongs to (and is licensed and set up with). */
export const SSO_INTEGRATION: Record<SsoProvider, string> = { microsoft: "m365", google: "google_workspace" };

export class SsoError extends Error {}

/** What the gate needs to exchange a code and check the token. */
export interface SsoClient {
  provider: SsoProvider;
  clientId: string;
  /** Microsoft: the directory (tenant) id people must belong to. */
  tenantId?: string;
  /** Google: the Workspace domains people must belong to. */
  domains?: string[];
}

const MS = "https://login.microsoftonline.com";

export function ssoEndpoints(c: Pick<SsoClient, "provider" | "tenantId">, base?: string) {
  if (c.provider === "microsoft") {
    const t = encodeURIComponent(c.tenantId ?? "");
    return {
      authorize: `${base ?? MS}/${t}/oauth2/v2.0/authorize`,
      token: `${MS}/${t}/oauth2/v2.0/token`,
      keys: `${MS}/${t}/discovery/v2.0/keys`,
    };
  }
  return { authorize: base ? `${base}/google/authorize` : "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", keys: "https://www.googleapis.com/oauth2/v3/certs" };
}

/** A random state, nonce and PKCE verifier for one sign-in, and the challenge sent with it. */
export function ssoStart() {
  const r = () => randomBytes(32).toString("base64url");
  const verifier = r();
  return { state: r(), nonce: r(), verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Where to send the browser. MOSS_SSO_STANDIN_URL replaces the provider's address in the e2e tests only. */
export function ssoAuthorizeUrl(c: SsoClient, p: { redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string }, standIn?: string) {
  const url = new URL(ssoEndpoints(c, standIn).authorize);
  const q = url.searchParams;
  q.set("client_id", c.clientId);
  q.set("response_type", "code");
  q.set("redirect_uri", p.redirectUri);
  q.set("scope", "openid email profile");
  q.set("state", p.state);
  q.set("nonce", p.nonce);
  q.set("code_challenge", p.challenge);
  q.set("code_challenge_method", "S256");
  if (c.provider === "microsoft") q.set("response_mode", "query");
  // Google: show only accounts in the allowed domain (a hint; the domain is checked on the token too).
  if (c.provider === "google" && c.domains?.length === 1) q.set("hd", c.domains[0]!);
  q.set("prompt", "select_account");
  return url.toString();
}

export interface SsoClaims {
  provider: SsoProvider;
  /** The person's lasting id at the provider (Microsoft: object id; Google: sub). */
  id: string;
  email: string;
  name?: string;
  nonce?: string;
  tenantId?: string;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

/** Where a provider publishes the keys its ID tokens are signed with. */
export const ssoKeysUrl = (c: Pick<SsoClient, "provider" | "tenantId">) =>
  c.provider === "microsoft" ? `${MS}/${encodeURIComponent(c.tenantId ?? "")}/discovery/v2.0/keys` : "https://www.googleapis.com/oauth2/v3/certs";

/** Checks an ID token and returns who it's for, or throws SsoError saying why not. */
export function verifyIdToken(token: string, keys: { keys?: JsonWebKey[] }, c: SsoClient, now = new Date()): SsoClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SsoError("The sign-in token is malformed");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64json(parts[0]!);
    claims = b64json(parts[1]!);
  } catch {
    throw new SsoError("The sign-in token is malformed");
  }
  if (header.alg !== "RS256") throw new SsoError("The sign-in token isn't signed the expected way");
  // Only RSA signing keys: a key published for encryption, or of another type, never checks a sign-in.
  const jwk = (keys.keys ?? []).find((k) => {
    const key = k as { kid?: string; kty?: string; use?: string };
    return key.kid === header.kid && key.kty === "RSA" && (key.use === undefined || key.use === "sig");
  });
  if (!jwk) throw new SsoError("The sign-in token was signed with a key the provider doesn't publish");
  const good = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  if (!good) throw new SsoError("The sign-in token's signature doesn't match");

  const t = now.getTime() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.clientId)) throw new SsoError("The sign-in token is for another application");
  if (typeof claims.exp !== "number" || claims.exp < t - 120) throw new SsoError("The sign-in token has expired");
  if (typeof claims.iat === "number" && claims.iat > t + 300) throw new SsoError("The sign-in token is from the future");
  const str = (k: string) => (typeof claims[k] === "string" ? (claims[k] as string) : undefined);

  if (c.provider === "microsoft") {
    const tid = str("tid");
    if (!c.tenantId || tid !== c.tenantId) throw new SsoError("That Microsoft account isn't in your organisation's directory");
    if (str("iss") !== `${MS}/${tid}/v2.0`) throw new SsoError("The sign-in token wasn't issued by Microsoft for your directory");
    const id = str("oid");
    // Entra's email claim isn't verified by Microsoft; within your own tenant, your admins control it.
    const email = (str("email") ?? str("preferred_username"))?.toLowerCase();
    if (!id || !email) throw new SsoError("The sign-in token has no account id or email");
    return { provider: "microsoft", id, email, name: str("name"), nonce: str("nonce"), tenantId: tid };
  }
  if (str("iss") !== "https://accounts.google.com" && str("iss") !== "accounts.google.com") throw new SsoError("The sign-in token wasn't issued by Google");
  const email = str("email")?.toLowerCase();
  if (!email || claims.email_verified !== true) throw new SsoError("That Google account's email isn't verified");
  const hd = str("hd")?.toLowerCase();
  const domains = (c.domains ?? []).map((d) => d.toLowerCase());
  if (!hd || !domains.includes(hd)) throw new SsoError("That Google account isn't in one of your organisation's domains");
  const id = str("sub");
  if (!id) throw new SsoError("The sign-in token has no account id");
  return { provider: "google", id, email, name: str("name"), nonce: str("nonce") };
}

/** Links a provider account to someone signed in (who proved it with their password). */
export async function linkSsoAccount(db: Database, orgId: string, userId: string, c: SsoClaims) {
  const subject = ssoSubject(c);
  const [other] = await db.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.oidcSubject, subject)));
  if (other && other.id !== userId) throw new SsoError(`That ${SSO_NAMES[c.provider]} account is already linked to someone else in MOSS.`);
  await db.update(users).set({ oidcSubject: subject, updatedAt: new Date() }).where(and(eq(users.id, userId), eq(users.orgId, orgId)));
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: "auth.sso_linked", targetType: "user", targetId: userId, details: { provider: c.provider, email: c.email, subject } });
}

/** How a person's provider account is remembered on their MOSS user. */
export function ssoSubject(c: SsoClaims): string {
  return c.provider === "microsoft" ? `microsoft:${c.tenantId}:${c.id}` : `google:${c.id}`;
}

/**
 * The MOSS user these claims sign in as: the one already linked to this account, or else the active one with this
 * email that isn't linked to another (it's linked now). Nobody new is created; anyone else is refused.
 */
export async function ssoUser(db: Database, orgId: string, c: SsoClaims) {
  const subject = ssoSubject(c);
  const [linked] = await db.select().from(users).where(and(eq(users.orgId, orgId), eq(users.oidcSubject, subject)));
  const audit = (action: string, details: Record<string, unknown>, userId: string | null = null) =>
    writeAudit(db, { orgId, actorType: userId ? "user" : "system", actorId: userId, action, targetType: "user", targetId: userId, details: { provider: c.provider, email: c.email, ...details } });
  if (linked) {
    if (linked.status === "disabled") {
      await audit("auth.sso_refused", { reason: "disabled" }, linked.id);
      throw new SsoError("Your MOSS account is disabled. Ask an admin.");
    }
    return linked;
  }
  const [byEmail] = await db
    .select()
    .from(users)
    .where(and(eq(users.orgId, orgId), sql`lower(${users.email}) = ${c.email.toLowerCase()}`, inArray(users.status, ["active", "invited"]), or(isNull(users.oidcSubject), eq(users.oidcSubject, ""))));
  if (!byEmail) {
    await audit("auth.sso_refused", { reason: "not_invited" });
    throw new SsoError(`${c.email} isn't in MOSS. Ask an admin to add you in Users, then sign in again.`);
  }
  // Someone with a MOSS password is never claimed by email alone (a provider's email isn't always verified):
  // they link their account themselves, signed in, in Settings.
  if (byEmail.passwordHash) {
    await audit("auth.sso_refused", { reason: "has_password" }, byEmail.id);
    throw new SsoError(`Sign in with your MOSS password first, then link your ${SSO_NAMES[c.provider]} account in Settings → General.`);
  }
  const [user] = await db.update(users).set({ oidcSubject: subject, status: "active", updatedAt: new Date() }).where(eq(users.id, byEmail.id)).returning();
  await audit("auth.sso_linked", { subject }, user!.id);
  return user!;
}

/** A provider's sign-in setup, from its integration: the client to use and the secret holding its client secret. */
export interface SsoSetup {
  client: SsoClient;
  secretName: string;
}

/** Google sign-in keeps its own OAuth client secret (the service account is for reading only). */
export const GOOGLE_SSO_SECRET = "google-oauth-secret";

export function ssoSetupFrom(provider: SsoProvider, c: IntegrationConfig): SsoSetup | null {
  if (c.options.ssoEnabled !== true) return null;
  if (provider === "microsoft") {
    const { tenantId, clientId } = c.fields;
    return tenantId && clientId ? { client: { provider, tenantId, clientId }, secretName: "m365-client-secret" } : null;
  }
  const clientId = typeof c.options.ssoClientId === "string" ? c.options.ssoClientId : "";
  const domains = Array.isArray(c.options.ssoDomains) ? c.options.ssoDomains.map(String).filter(Boolean) : [];
  return clientId && domains.length ? { client: { provider, clientId, domains }, secretName: GOOGLE_SSO_SECRET } : null;
}

/** The provider's setup if signing in with it is on: its integration licensed and switched on, and sign-in set up. */
export async function ssoAvailable(db: Database, orgId: string, provider: SsoProvider): Promise<SsoSetup | null> {
  const def = getIntegration(SSO_INTEGRATION[provider]);
  if (!def || !(await integrationLicensed(db, orgId, def))) return null;
  const it = await loadIntegration(db, orgId, def);
  return it.enabled ? ssoSetupFrom(provider, it.config) : null;
}

/** Whether anyone can sign in with Microsoft or Google right now. "Single sign-on only" applies only while so. */
export async function anySsoAvailable(db: Database, orgId: string): Promise<boolean> {
  for (const p of SSO_PROVIDERS) if (await ssoAvailable(db, orgId, p)) return true;
  return false;
}
