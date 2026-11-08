import { describePolicy, getPasswordPolicy, getSetting } from "@moss/core";
import { hostPins } from "@moss/db";
import { asc, eq, sql } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { changePasswordAction, hostPinAction, savePasswordPolicyAction } from "./actions";
import { Masonry } from "@/components/masonry";

export const metadata = { title: "Security" };

/** Your password, and (for admins) the password policy everyone follows. */
export default async function SecurityPage({ searchParams }: PageProps<"/settings/security">) {
  const user = await requireUser({ unblocks: "change_password" });
  const sp = await searchParams;
  const policy = await getPasswordPolicy(db(), user.orgId);
  const canManage = user.permissions.has("settings.manage");
  const [pins, pinning] = canManage
    ? await Promise.all([
        db().select().from(hostPins).where(eq(hostPins.orgId, user.orgId)).orderBy(sql`${hostPins.changedAt} desc nulls last`, asc(hostPins.host), asc(hostPins.port)),
        getSetting(db(), user.orgId, "tools.pin_hosts"),
      ])
    : [[], false];

  return (
    <>
      <PageHeader title="Settings" description="Your password, and the rules everyone's passwords follow." />
      {(sp.required === "change_password" || user.blocker === "change_password") && (
        <Alert className="mb-6">
          <AlertTitle>Time for a new password</AlertTitle>
          <AlertDescription>Your password is older than the policy allows. Change it below to carry on.</AlertDescription>
        </Alert>
      )}
      <Masonry gap={24} className="lg:grid-cols-2">
        <Card id="password">
          <CardHeader>
            <CardTitle>Change your password</CardTitle>
            <CardDescription>{describePolicy(policy)}</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={changePasswordAction} submitLabel="Change password" resetOnSuccess>
              <TextField label="Current password" name="current" type="password" autoComplete="current-password" required />
              <TextField label="New password" name="password" type="password" autoComplete="new-password" minLength={policy.minLength} required />
              <TextField label="New password again" name="confirm" type="password" autoComplete="new-password" required />
            </ActionForm>
          </CardContent>
        </Card>

        {canManage && (
          <Card id="policy">
            <CardHeader>
              <CardTitle>Password policy</CardTitle>
              <CardDescription>
                Applies when a password is set or changed. People who sign in with single sign-on are left out: their identity provider sets their rules.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={savePasswordPolicyAction} submitLabel="Save policy">
                <TextField label="Minimum length" name="minLength" type="number" min={12} max={128} defaultValue={policy.minLength} hint="12 at least. Longer beats complicated." />
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-sm font-medium">Must include</legend>
                  <CheckboxField label="A lowercase letter" name="requireLower" defaultChecked={policy.requireLower} />
                  <CheckboxField label="A capital letter" name="requireUpper" defaultChecked={policy.requireUpper} />
                  <CheckboxField label="A digit" name="requireDigit" defaultChecked={policy.requireDigit} />
                  <CheckboxField label="A symbol" name="requireSymbol" defaultChecked={policy.requireSymbol} />
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="Remember old passwords" name="history" type="number" min={0} max={24} defaultValue={policy.history} hint="Refuse reusing this many. 0: off." />
                  <TextField label="Change every (days)" name="maxAgeDays" type="number" min={0} max={3650} defaultValue={policy.maxAgeDays} hint="0: never. Forced changes rarely help; length and two-factor do." />
                </div>
                <SelectField
                  label="Two-factor sign-in"
                  name="requireTotp"
                  defaultValue={policy.requireTotp}
                  options={[
                    { value: "none", label: "Optional" },
                    { value: "admins", label: "Required for owners and admins" },
                    { value: "everyone", label: "Required for everyone" },
                  ]}
                  hint="Anyone without it is asked to set it up the next time they use MOSS."
                />
                <CheckboxField
                  label="Refuse passwords found in known data breaches"
                  name="checkBreached"
                  defaultChecked={policy.checkBreached}
                  hint="Checked with Have I Been Pwned. Only the first 5 characters of the password's SHA-1 hash are sent, never the password."
                />
              </ActionForm>
            </CardContent>
          </Card>
        )}

        {canManage && (
          <Card id="device-keys" className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Device keys</CardTitle>
              <CardDescription>
                The certificate or SSH host key each device presented the first time MOSS sent it a credential. If a device presents a different one, MOSS sends it nothing
                until you check the device and trust the new key. {pinning ? "" : "Remembering device keys is off (Settings, Safety)."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {pins.length === 0 && <p className="text-muted-foreground">No device has been sent a credential yet.</p>}
              {pins.map((p) => (
                <div key={p.id} className="flex flex-wrap items-start justify-between gap-3 border-t-2 pt-3 first:border-t-0 first:pt-0">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {p.host}:{p.port} <span className="text-muted-foreground">· {p.kind === "tls" ? "TLS certificate" : "SSH host key"}</span>
                    </div>
                    <div className="break-all font-mono text-xs text-muted-foreground">{p.fingerprint || "Not trusted yet"}</div>
                    {p.changedTo && (
                      <div className="mt-1 text-alarm" role="alert">
                        {p.fingerprint ? "Changed" : "A new port on a device MOSS knows, first seen"} {p.changedAt?.toLocaleString()}:{" "}
                        <span className="break-all font-mono text-xs">{p.changedTo}</span>. Check this on the device (a new certificate after an update, or a device
                        replaced) before trusting it. If you can&apos;t explain it, something else may be answering at this address.
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {p.changedTo && <ActionForm action={hostPinAction.bind(null, p.id, "trust", p.changedTo)} submitLabel="Trust new key" inline confirm={`Trust ${p.changedTo} for ${p.host}? Credentials will go to it again.`} />}
                    <ActionForm action={hostPinAction.bind(null, p.id, "forget", null)} submitLabel="Forget" submitVariant="outline" inline />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </Masonry>
    </>
  );
}
