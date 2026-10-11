import { describePolicy, getPasswordPolicy } from "@moss/core";
import { ActionForm } from "@/components/action-form";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { changePasswordAction, savePasswordPolicyAction } from "./actions";

export const metadata = { title: "Security" };

/** Your password, and (for admins) the password policy everyone follows. */
export default async function SecurityPage({ searchParams }: PageProps<"/settings/security">) {
  const user = await requireUser({ unblocks: "change_password" });
  const sp = await searchParams;
  const policy = await getPasswordPolicy(db(), user.orgId);
  const canManage = user.permissions.has("settings.manage");

  return (
    <>
      <PageHeader title="Settings" description="Your password, and the rules everyone's passwords follow." />
      {(sp.required === "change_password" || user.blocker === "change_password") && (
        <Alert className="mb-6">
          <AlertTitle>Time for a new password</AlertTitle>
          <AlertDescription>Your password is older than the policy allows. Change it below to carry on.</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
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
      </div>
    </>
  );
}
