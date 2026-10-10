// Single sign-on, the web app's part: where to send the browser, a short-lived signed cookie holding the state,
// nonce and PKCE verifier for one sign-in, and the redirect address the provider must have registered.
import "server-only";
import { SSO_PROVIDERS, ssoAvailable, type SsoProvider } from "@moss/core";
import { orgs } from "@moss/db";
import { createHmac, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { config } from "./config";
import { db } from "./db";

export const SSO_COOKIE = "moss_sso";
/** Long enough to sign in at the provider (with MFA), short enough not to linger. */
export const SSO_COOKIE_SECONDS = 600;

export function isSsoProvider(p: string): p is SsoProvider {
  return (SSO_PROVIDERS as readonly string[]).includes(p);
}

/** The org people sign in to (an install has one). */
export async function ssoOrgId(): Promise<string | null> {
  const [o] = await db().select({ id: orgs.id }).from(orgs).limit(1);
  return o?.id ?? null;
}

/** The providers whose button the sign-in page shows. */
export async function availableSsoProviders(): Promise<SsoProvider[]> {
  const orgId = await ssoOrgId();
  if (!orgId) return [];
  const out: SsoProvider[] = [];
  for (const p of SSO_PROVIDERS) if (await ssoAvailable(db(), orgId, p)) out.push(p);
  return out;
}

/** The address this request came in on (as the browser sees it, through the https service). */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || "localhost";
  return `${proto}://${host}`;
}

export const ssoRedirectUri = (origin: string, provider: SsoProvider) => `${origin}/api/auth/sso/${provider}/callback`;

export interface SsoCookie {
  provider: SsoProvider;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** Where to go after signing in. */
  next: string;
}

const mac = (body: string) => createHmac("sha256", config.appKey()).update(`moss-sso:${body}`).digest("base64url");

export function sealSsoCookie(c: SsoCookie): string {
  const body = Buffer.from(JSON.stringify({ ...c, exp: Date.now() + SSO_COOKIE_SECONDS * 1000 })).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function openSsoCookie(value: string | undefined): SsoCookie | null {
  const [body, sig] = (value ?? "").split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SsoCookie & { exp: number };
  return c.exp > Date.now() ? c : null;
}

/** Only paths in MOSS itself, so the sign-in can't be used to send someone elsewhere. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next.slice(0, 500) : "/";
}
