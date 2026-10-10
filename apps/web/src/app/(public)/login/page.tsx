import { redirect } from "next/navigation";
import { getCurrentUser, isSetUp } from "@/server/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (!(await isSetUp())) redirect("/setup");
  if (await getCurrentUser()) redirect("/");
  return (
    <>
      <h1 className="mb-6 text-lg font-semibold text-ink dark:text-beige">Sign in to the basement</h1>
      <LoginForm />
    </>
  );
}
