"use client";

import { ActionForm } from "@/components/action-form";
import { TextField } from "@/components/field";
import { loginAction } from "../actions";

export function LoginForm() {
  return (
    <ActionForm action={loginAction} submitLabel="Sign in">
      {(state) => (
        <>
          <TextField label="Email" name="email" type="email" autoComplete="username" required autoFocus />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
          {state?.needTotp && (
            <TextField label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} autoFocus />
          )}
        </>
      )}
    </ActionForm>
  );
}
