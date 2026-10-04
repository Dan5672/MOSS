"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type FormState = { ok?: boolean; error?: string; message?: string; needTotp?: boolean } | undefined;
type ServerAction = (state: FormState, form: FormData) => Promise<FormState>;

/** A form bound to a server action: shows errors inline, toasts success, optionally resets. */
export function ActionForm({
  action,
  children,
  submitLabel,
  submitVariant = "default",
  resetOnSuccess = false,
  confirm,
  className,
  inline = false,
}: {
  action: ServerAction;
  children?: ReactNode | ((state: FormState) => ReactNode);
  submitLabel: string;
  submitVariant?: "default" | "destructive" | "outline" | "secondary";
  resetOnSuccess?: boolean;
  /** Ask before submitting (for destructive actions). */
  confirm?: string;
  className?: string;
  inline?: boolean;
}) {
  // Toast as soon as the action returns: the refreshed page may no longer contain this form
  // (e.g. the approve panel disappears once a change is approved), so an effect would miss it.
  const [state, formAction, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const result = await action(prev, form);
    if (result?.ok && result.message) toast.success(result.message);
    return result;
  }, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={formRef}
      // Submit through a transition instead of the `action` prop: React resets a form after an
      // action-prop submission, which would wipe the fields when the server returns an error
      // (or when login asks for the 2FA code).
      onSubmit={(e) => {
        e.preventDefault();
        if (confirm && !window.confirm(confirm)) return;
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className={cn(inline ? "flex flex-wrap items-end gap-2" : "grid gap-4", className)}
    >
      {typeof children === "function" ? children(state) : children}
      {state?.error && (
        <p role="alert" className={cn("text-sm text-destructive whitespace-pre-line", inline && "basis-full")}>
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant={submitVariant} disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
