// Starts signing in with Microsoft or Google: remembers the state, nonce and PKCE verifier in a short-lived signed
// cookie and sends the browser to the provider.
import { SSO_NAMES, ssoAuthorizeUrl, ssoAvailable, ssoStart } from "@moss/core";
import { cookies } from "next/headers";
import { db } from "@/server/db";
import { isSsoProvider, requestOrigin, safeNext, sealSsoCookie, SSO_COOKIE, SSO_COOKIE_SECONDS, ssoOrgId, ssoRedirectUri } from "@/server/sso";

export async function GET(req: Request, ctx: RouteContext<"/api/auth/sso/[provider]/start">) {
  const { provider } = await ctx.params;
  const origin = await requestOrigin();
  const back = (error: string) => Response.redirect(`${origin}/login?sso_error=${encodeURIComponent(error)}`, 303);
  if (!isSsoProvider(provider)) return back("Unknown sign-in provider.");
  const orgId = await ssoOrgId();
  const setup = orgId ? await ssoAvailable(db(), orgId, provider) : null;
  if (!setup) return back(`Signing in with ${SSO_NAMES[provider]} isn't switched on.`);

  const s = ssoStart();
  const redirectUri = ssoRedirectUri(origin, provider);
  (await cookies()).set(SSO_COOKIE, sealSsoCookie({ provider, state: s.state, nonce: s.nonce, verifier: s.verifier, redirectUri, next: safeNext(new URL(req.url).searchParams.get("next")) }), {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: "/api/auth/sso",
    maxAge: SSO_COOKIE_SECONDS,
  });
  // MOSS_SSO_STANDIN_URL: the e2e tests' stand-in provider, never set in a real install.
  return Response.redirect(ssoAuthorizeUrl(setup.client, { redirectUri, ...s }, process.env.MOSS_SSO_STANDIN_URL || undefined), 303);
}
