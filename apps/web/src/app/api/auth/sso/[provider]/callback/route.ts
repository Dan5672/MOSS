// Back from Microsoft or Google: check the state, have the gate exchange the code and check the token, check the
// nonce, then sign in the MOSS user it belongs to (only people already in MOSS).
import { linkSsoAccount, SSO_NAMES, SsoError, ssoUser, writeAudit, type SsoClaims } from "@moss/core";
import { cookies } from "next/headers";
import { getCurrentUser, startSession } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { isSsoProvider, openSsoCookie, requestOrigin, sealSsoCookie, SSO_2FA_COOKIE, SSO_2FA_SECONDS, SSO_COOKIE, ssoOrgId } from "@/server/sso";

export async function GET(req: Request, ctx: RouteContext<"/api/auth/sso/[provider]/callback">) {
  const { provider } = await ctx.params;
  const origin = await requestOrigin();
  const back = (error: string) => Response.redirect(`${origin}/login?sso_error=${encodeURIComponent(error)}`, 303);
  const jar = await cookies();
  const saved = openSsoCookie(jar.get(SSO_COOKIE)?.value);
  jar.delete({ name: SSO_COOKIE, path: "/api/auth/sso" });
  if (!isSsoProvider(provider)) return back("Unknown sign-in provider.");
  const name = SSO_NAMES[provider];

  const q = new URL(req.url).searchParams;
  if (q.get("error")) return back(`${name} didn't sign you in: ${(q.get("error_description") ?? q.get("error"))!.split("\n")[0]!.slice(0, 200)}`);
  // The state proves this browser started this sign-in (no one else's code can be slipped in).
  if (!saved || saved.provider !== provider || !q.get("state") || q.get("state") !== saved.state) return back("That sign-in had expired or didn't start here. Try again.");
  const code = q.get("code");
  if (!code) return back(`${name} sent no sign-in code.`);
  const orgId = await ssoOrgId();
  if (!orgId) return back("MOSS isn't set up yet.");

  let body: { ok?: boolean; claims?: SsoClaims; error?: string };
  try {
    const res = await fetch(`${config.gateUrl()}/v1/web/sso/${provider}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.webToken()}` },
      body: JSON.stringify({ orgId, code, redirectUri: saved.redirectUri, codeVerifier: saved.verifier }),
      signal: AbortSignal.timeout(30_000),
    });
    body = (await res.json().catch(() => ({}))) as typeof body;
  } catch {
    return back("MOSS couldn't finish signing you in (the gate is unavailable). Try again.");
  }
  if (!body.ok || !body.claims) return back(body.error ?? `${name} sign-in failed.`);
  // The nonce ties the token to this sign-in (an old token can't be replayed).
  if (body.claims.nonce !== saved.nonce) return back("That sign-in token wasn't for this sign-in. Try again.");

  // Linking: to the person who asked, still signed in. No new session.
  if (saved.linkUserId) {
    const me = await getCurrentUser();
    const toSettings = (q: string) => Response.redirect(`${origin}/settings?${q}#sign-in-accounts`, 303);
    if (!me || me.id !== saved.linkUserId) return toSettings(`sso_error=${encodeURIComponent("Sign in to MOSS again, then link your account.")}`);
    try {
      await linkSsoAccount(db(), orgId, me.id, body.claims);
      return toSettings(`sso_linked=${provider}`);
    } catch (err) {
      if (err instanceof SsoError) return toSettings(`sso_error=${encodeURIComponent(err.message)}`);
      throw err;
    }
  }

  try {
    const user = await ssoUser(db(), orgId, body.claims);
    // Two-factor in MOSS still applies: the provider may not ask for a second factor at all.
    if (user.totpSecretRef) {
      jar.set(SSO_2FA_COOKIE, sealSsoCookie({ userId: user.id, provider, next: saved.next }, SSO_2FA_SECONDS), {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        path: "/login",
        maxAge: SSO_2FA_SECONDS,
      });
      return Response.redirect(`${origin}/login?sso_2fa=1`, 303);
    }
    await startSession(user.id, provider);
    await writeAudit(db(), { orgId, actorType: "user", actorId: user.id, action: "auth.login", details: { method: provider } });
    return Response.redirect(`${origin}${saved.next}`, 303);
  } catch (err) {
    if (err instanceof SsoError) return back(err.message);
    throw err;
  }
}
