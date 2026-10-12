import { SSO_NAMES } from "@moss/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { TextField } from "@/components/field";
import { getCurrentUser, isSetUp } from "@/server/auth";
import { availableSsoProviders, openSsoCookie, SSO_2FA_COOKIE, type SsoSecondFactor } from "@/server/sso";
import { ssoSecondFactorAction } from "../actions";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (!(await isSetUp())) redirect("/setup");
  if (await getCurrentUser()) redirect("/");
  const [providers, q] = await Promise.all([availableSsoProviders(), searchParams]);
  const ssoError = typeof q.sso_error === "string" ? q.sso_error.slice(0, 300) : null;
  const pending = q.sso_2fa ? openSsoCookie<SsoSecondFactor>((await cookies()).get(SSO_2FA_COOKIE)?.value) : null;
  if (pending) {
    return (
      <>
        <h1 className="mb-2 text-lg font-semibold text-ink dark:text-beige">One more step</h1>
        <p className="mb-6 text-sm text-muted-foreground">You have two-factor sign-in on in MOSS. Enter the code from your authenticator app.</p>
        <ActionForm action={ssoSecondFactorAction} submitLabel="Sign in">
          <TextField label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required />
        </ActionForm>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-6 text-lg font-semibold text-ink dark:text-beige">Sign in to the basement</h1>
      {ssoError && (
        <p role="alert" className="mb-4 border-2 border-alarm p-3 text-sm">
          {ssoError}
        </p>
      )}
      {providers.length > 0 && (
        <div className="mb-6 grid gap-2">
          {providers.map((p) => (
            <a key={p} href={`/api/auth/sso/${p}/start`} className="border-2 px-3 py-2 text-center font-mono text-sm hover:bg-muted">
              Sign in with {SSO_NAMES[p]}
            </a>
          ))}
          <p className="text-center text-xs text-muted-foreground">or with your MOSS password</p>
        </div>
      )}
      <LoginForm />
    </>
  );
}
