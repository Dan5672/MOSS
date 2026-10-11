import { SSO_NAMES, type SsoProvider } from "@moss/core";
import { users } from "@moss/db";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CurrentUser } from "@/server/auth";
import { db } from "@/server/db";
import { availableSsoProviders } from "@/server/sso";
import { unlinkSsoAction } from "./sso-link-actions";

/** Your Microsoft or Google account for signing in: linked or not, link it (with your password) or unlink it. */
export async function SignInAccounts({ user, linked, error }: { user: CurrentUser; linked?: string; error?: string }) {
  const providers = await availableSsoProviders();
  if (!providers.length) return null;
  const [row] = await db().select({ subject: users.oidcSubject }).from(users).where(eq(users.id, user.id));
  const current = row?.subject ? (row.subject.split(":")[0] as SsoProvider) : null;

  return (
    <Card id="sign-in-accounts" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>Sign-in accounts</CardTitle>
        <CardDescription>Sign in to MOSS with your work account instead of your password.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {linked && <p role="status">Linked your {SSO_NAMES[linked as SsoProvider] ?? linked} account. You can sign in with it now.</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <p>{current ? `Linked to your ${SSO_NAMES[current] ?? current} account.` : "No account linked yet."}</p>
        {user.hasPassword && (
          <div className="flex flex-wrap gap-2">
            {providers
              .filter((p) => p !== current)
              .map((p) => (
                <FormDialog key={p} label={`Link your ${SSO_NAMES[p]} account`} variant="outline" title={`Link your ${SSO_NAMES[p]} account`} description={`Confirm your password, then sign in with ${SSO_NAMES[p]}.`}>
                  {/* A plain form: the browser goes on to the provider and back. */}
                  <form method="post" action={`/api/auth/sso/${p}/link`} className="grid gap-3">
                    <TextField label="Your MOSS password" name="password" type="password" autoComplete="current-password" required />
                    <Button type="submit" className="w-fit">
                      Continue to {SSO_NAMES[p]}
                    </Button>
                  </form>
                </FormDialog>
              ))}
            {current && <ActionForm action={unlinkSsoAction} submitLabel="Unlink" submitVariant="outline" inline />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
