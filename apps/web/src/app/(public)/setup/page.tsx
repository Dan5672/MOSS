import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { TextField } from "@/components/field";
import { isSetUp } from "@/server/auth";
import { setupAction } from "../actions";

export const metadata = { title: "Set up" };

export default async function SetupPage() {
  if (await isSetUp()) redirect("/login");
  return (
    <>
      <h1 className="text-lg font-semibold text-ink dark:text-beige">Welcome to MOSS</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">Create your organisation and the owner account. You can add more people later.</p>
      <ActionForm action={setupAction} submitLabel="Create and sign in">
        <TextField label="Name for this network" name="orgName" placeholder="Home" required />
        <TextField label="Your name" name="ownerName" autoComplete="name" required />
        <TextField label="Email" name="ownerEmail" type="email" autoComplete="email" required />
        <TextField label="Password" name="ownerPassword" type="password" autoComplete="new-password" minLength={12} required hint="At least 12 characters." />
        <TextField label="Confirm password" name="confirmPassword" type="password" autoComplete="new-password" required />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="accept" className="mt-1" required />
          <span>
            I own this network or am authorised to scan and manage it. MOSS won&apos;t scan anything until I mark a network as
            allowed.
          </span>
        </label>
      </ActionForm>
    </>
  );
}
