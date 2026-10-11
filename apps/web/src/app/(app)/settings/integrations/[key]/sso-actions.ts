"use server";

import { anySsoAvailable, GOOGLE_SSO_SECRET, getIntegration, integrationLicensed, loadIntegration, saveModule, setSetting, ssoSetupFrom, writeAudit, type SsoProvider } from "@moss/core";
import { secrets } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { act, formObject, type ActionState } from "@/server/action";
import { isOwner, PermissionError, requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { storeSecret } from "@/server/services";

const KEY: Record<SsoProvider, string> = { microsoft: "m365", google: "google_workspace" };

/** Turns signing in with Microsoft or Google on or off, and (Google) sets its OAuth client. */
export async function saveSsoAction(provider: SsoProvider, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    // Who can sign in decides who can become whom, so only owners change it (an admin pointing sign-in at a
    // directory they control could sign in as anyone added without a password).
    if (!(await isOwner(user.id))) throw new Error("Only an owner can change single sign-on.");
    if (!user.permissions.has("settings.manage")) throw new PermissionError("settings.manage");
    if (!user.permissions.has("secrets.manage")) throw new PermissionError("secrets.manage");
    const def = getIntegration(KEY[provider])!;
    if (!(await integrationLicensed(db(), user.orgId, def))) throw new Error(`${def.name} needs a business licence: add one in Settings → About.`);
    const { config } = await loadIntegration(db(), user.orgId, def);
    const f = formObject(form);
    const enabled = f.ssoEnabled === "on";
    const options: Record<string, unknown> = { ...config.options, ssoEnabled: enabled };

    if (provider === "google") {
      const clientId = (f.ssoClientId ?? "").trim();
      if (clientId && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("The client ID ends in .apps.googleusercontent.com.");
      const domains = [...new Set((f.ssoDomains ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];
      const bad = domains.filter((d) => !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d));
      if (bad.length) throw new Error(`Not a domain: ${bad.join(", ")}.`);
      options.ssoClientId = clientId;
      options.ssoDomains = domains;
      if (f.ssoClientSecret) {
        await storeSecret({ userId: user.id, name: GOOGLE_SSO_SECRET, type: "api_token", value: f.ssoClientSecret, description: "Google sign-in OAuth client secret", allowedTools: ["oidc_exchange"] });
      }
      if (enabled) {
        if (!clientId || !domains.length) throw new Error("Enter the client ID and at least one domain to switch Google sign-in on.");
        const [s] = await db().select({ id: secrets.id }).from(secrets).where(and(eq(secrets.orgId, user.orgId), eq(secrets.name, GOOGLE_SSO_SECRET)));
        if (!s) throw new Error("Enter the client secret.");
      }
    } else if (enabled && !ssoSetupFrom(provider, { ...config, options })) {
      throw new Error("Save the connection (directory ID, application ID and client secret) first.");
    }
    await saveModule(db(), user.orgId, def.key, { config: { ...config, options } }, { type: "user", id: user.id });
    // Turning the last sign-in off can't leave people unable to sign in.
    if (!enabled && !(await anySso(user.orgId))) await setSetting(db(), user.orgId, "auth.sso_only", false);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.sso_settings", targetType: "module", targetId: def.key, details: { provider, enabled } });
    revalidatePath(`/settings/integrations/${def.key}`);
    return enabled ? `People in MOSS can now sign in with ${provider === "microsoft" ? "Microsoft" : "Google"}.` : "Saved. Signing in this way is off.";
  });
}

const anySso = (orgId: string) => anySsoAvailable(db(), orgId);

/** Single sign-on only: everyone but owners must sign in with Microsoft or Google. */
export async function setSsoOnlyAction(on: boolean, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    if (!(await isOwner(user.id))) throw new Error("Only an owner can change single sign-on.");
    if (on && !(await anySso(user.orgId))) throw new Error("Switch on signing in with Microsoft or Google first.");
    await setSetting(db(), user.orgId, "auth.sso_only", on);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: "auth.sso_only", details: { value: on } });
    revalidatePath("/settings/integrations");
    return on ? "Only owners can sign in with a password now; everyone else signs in with Microsoft or Google." : "Everyone can sign in with their MOSS password again.";
  });
}
