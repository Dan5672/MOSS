// Starts signing in with Microsoft or Google: remembers the state, nonce and PKCE verifier in a short-lived signed
// cookie and sends the browser to the provider.
import { SSO_NAMES, ssoAuthorizeUrl, ssoAvailable, ssoStart } from "@moss/core";
import { cookies } from "next/headers";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth";
import { isSsoProvider, openSsoCookie, requestOrigin, safeNext, sealSsoCookie, SSO_COOKIE, SSO_COOKIE_SECONDS, SSO_LINK_COOKIE, ssoOrgId, ssoRedirectUri, type SsoLinkIntent } from "@/server/sso";

export async function GET(req: Request, ctx: RouteContext<"/api/auth/sso/[provider]/start">) {
  const { provider } = await ctx.params;
  const origin = await requestOrigin();
  const back = (error: string) => Response.redirect(`${origin}/login?sso_error=${encodeURIComponent(error)}`, 303);
  if (!isSsoProvider(provider)) return back("Unknown sign-in provider.");
  const orgId = await ssoOrgId();
  const setup = orgId ? await ssoAvailable(db(), orgId, provider) : null;
  if (!setup) return back(`Signing in with ${SSO_NAMES[provider]} isn't switched on.`);

  // Linking an account to the person signed in: only with the intent they made by confirming their password.
  const jar = await cookies();
  let linkUserId: string | undefined;
  if (new URL(req.url).searchParams.get("link") === "1") {
    const intent = openSsoCookie<SsoLinkIntent>(jar.get(SSO_LINK_COOKIE)?.value);
    jar.delete({ name: SSO_LINK_COOKIE, path: "/api/auth/sso" });
    const me = await getCurrentUser();
    if (!intent || !me || intent.userId !== me.id || intent.provider !== provider) return Response.redirect(`${origin}/settings?sso_error=${encodeURIComponent("Linking had expired. Try again.")}`, 303);
    linkUserId = me.id;
  }

  const s = ssoStart();
  const redirectUri = ssoRedirectUri(origin, provider);
  jar.set(SSO_COOKIE, sealSsoCookie({ provider, state: s.state, nonce: s.nonce, verifier: s.verifier, redirectUri, next: linkUserId ? "/settings" : safeNext(new URL(req.url).searchParams.get("next")), ...(linkUserId ? { linkUserId } : {}) }), {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: "/api/auth/sso",
    maxAge: SSO_COOKIE_SECONDS,
  });
  // MOSS_SSO_STANDIN_URL: the e2e tests' stand-in provider, never set in a real install.
  return Response.redirect(ssoAuthorizeUrl(setup.client, { redirectUri, ...s }, process.env.MOSS_SSO_STANDIN_URL || undefined), 303);
}
