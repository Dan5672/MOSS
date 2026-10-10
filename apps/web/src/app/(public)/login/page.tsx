import { SSO_NAMES } from "@moss/core";
import { redirect } from "next/navigation";
import { getCurrentUser, isSetUp } from "@/server/auth";
import { availableSsoProviders } from "@/server/sso";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (!(await isSetUp())) redirect("/setup");
  if (await getCurrentUser()) redirect("/");
  const [providers, q] = await Promise.all([availableSsoProviders(), searchParams]);
  const ssoError = typeof q.sso_error === "string" ? q.sso_error.slice(0, 300) : null;
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
