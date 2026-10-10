// Linking your Microsoft or Google account (a plain form post from Settings, so the browser goes on to the provider):
// you must be signed in and confirm your password. It leaves a 2-minute signed intent the start route checks.
import { ssoAvailable, verifyPassword } from "@moss/core";
import { users } from "@moss/db";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/server/auth";
import { db } from "@/server/db";
import { isSsoProvider, requestOrigin, sealSsoCookie, SSO_LINK_COOKIE } from "@/server/sso";

export async function POST(req: Request, ctx: RouteContext<"/api/auth/sso/[provider]/link">) {
  const { provider } = await ctx.params;
  const origin = await requestOrigin();
  const back = (error: string) => Response.redirect(`${origin}/settings?sso_error=${encodeURIComponent(error)}#sign-in-accounts`, 303);
  const me = await getCurrentUser();
  if (!me) return Response.redirect(`${origin}/login`, 303);
  if (!isSsoProvider(provider) || !(await ssoAvailable(db(), me.orgId, provider))) return back("Signing in that way isn't switched on.");
  const form = await req.formData();
  const [row] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, me.id));
  if (!row?.hash || !(await verifyPassword(String(form.get("password") ?? ""), row.hash))) return back("Incorrect password.");
  (await cookies()).set(SSO_LINK_COOKIE, sealSsoCookie({ userId: me.id, provider }, 120), { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/api/auth/sso", maxAge: 120 });
  return Response.redirect(`${origin}/api/auth/sso/${provider}/start?link=1`, 303);
}
