import { GOOGLE_SSO_SECRET, getSetting, ssoSetupFrom, type IntegrationConfig, type SsoProvider } from "@moss/core";
import { secrets } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { CheckboxField, TextField } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { requestOrigin, ssoRedirectUri } from "@/server/sso";
import { saveSsoAction, setSsoOnlyAction } from "./sso-actions";

/** Signing in to MOSS with Microsoft or Google: the redirect address to register, switching it on, and SSO only. */
export async function SsoCard({ orgId, provider, config, enabled, canManage }: { orgId: string; provider: SsoProvider; config: IntegrationConfig; enabled: boolean; canManage: boolean }) {
  const name = provider === "microsoft" ? "Microsoft" : "Google";
  const origin = await requestOrigin();
  const redirectUri = ssoRedirectUri(origin, provider);
  const host = new URL(origin).hostname;
  // Google only accepts redirect addresses on a public domain name.
  const googleNeedsName = provider === "google" && (/^[\d.]+$/.test(host) || !host.includes(".") || /\.(lan|local|home|internal|localdomain)$/.test(host));
  const [ssoOnly, [googleSecret]] = await Promise.all([
    getSetting(db(), orgId, "auth.sso_only"),
    provider === "google" ? db().select({ id: secrets.id }).from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, GOOGLE_SSO_SECRET))) : Promise.resolve([]),
  ]);
  const on = config.options.ssoEnabled === true && !!ssoSetupFrom(provider, config);
  const domains = Array.isArray(config.options.ssoDomains) ? config.options.ssoDomains.join(", ") : "";

  return (
    <Card id="sso" className="scroll-mt-6 lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Sign in with {name} <Badge variant={on && enabled ? "default" : "outline"}>{on ? (enabled ? "On" : "On when the integration is") : "Off"}</Badge>
        </CardTitle>
        <CardDescription>
          People already in MOSS (Users) can sign in with their {name} account; they&apos;re matched by email the first time. Nobody new gets in this
          way. {name} checks their password and MFA, so MOSS doesn&apos;t ask for its own two-factor code.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-1">
          <p>
            {provider === "microsoft"
              ? "In the app registration's Authentication, add a Web platform with this redirect URI:"
              : "In Google Cloud, APIs & Services > Credentials > Create OAuth client ID (Web application), with this authorised redirect URI:"}
          </p>
          <code className="break-all bg-muted p-2 font-mono text-xs" aria-label="Redirect URI">
            {redirectUri}
          </code>
          <p className="text-xs text-muted-foreground">
            It&apos;s the address you opened MOSS with. People must sign in through the same address.
            {googleNeedsName && " Google only accepts a real domain name here (not an IP address or .lan): open MOSS by its Let's Encrypt or Tailscale (ts.net) name, then copy the address again."}
          </p>
        </div>
        {canManage && (
          <ActionForm action={saveSsoAction.bind(null, provider)} submitLabel="Save sign-in">
            {provider === "google" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="OAuth client ID" name="ssoClientId" defaultValue={typeof config.options.ssoClientId === "string" ? config.options.ssoClientId : ""} placeholder="….apps.googleusercontent.com" />
                <TextField
                  label="OAuth client secret"
                  name="ssoClientSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={googleSecret ? "Saved. Leave blank to keep it." : undefined}
                  hint={`Stored encrypted as secret:${GOOGLE_SSO_SECRET}, usable only for signing in.`}
                />
                <TextField label="Your Workspace domains" name="ssoDomains" defaultValue={domains} placeholder="acme.com" hint="Only accounts in these domains can sign in. Separate several with commas." />
              </div>
            )}
            <CheckboxField label={`Let people sign in with ${name}`} name="ssoEnabled" defaultChecked={config.options.ssoEnabled === true} />
          </ActionForm>
        )}
        {canManage && on && (
          <div className="grid gap-2 border-t pt-3">
            <p>
              <strong>Single sign-on only</strong> {ssoOnly ? "is on" : "is off"}: {ssoOnly ? "only owners can sign in with a MOSS password." : "everyone can also sign in with their MOSS password."} Owners
              always keep their password and two-factor, in case sign-in with {name} breaks.
            </p>
            <div>
              <ActionForm
                action={setSsoOnlyAction.bind(null, !ssoOnly)}
                submitLabel={ssoOnly ? "Allow passwords again" : "Switch on single sign-on only"}
                submitVariant="outline"
                confirm={ssoOnly ? undefined : "Only owners will be able to sign in with a password. Everyone else must sign in with Microsoft or Google. Continue?"}
                inline
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
