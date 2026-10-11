"use client";

import { startTransition, useActionState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createHomeAssistantTokenAction } from "../actions";

/** Makes a token for the Home Assistant integration and shows it, once, to copy. */
export function TokenForm() {
  const [state, action, pending] = useActionState(async (prev: Awaited<ReturnType<typeof createHomeAssistantTokenAction>>, form: FormData) => {
    const result = await createHomeAssistantTokenAction(prev, form);
    if (result?.ok && result.message) toast.success(result.message);
    return result;
  }, undefined);
  return (
    <div className="grid gap-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startTransition(() => action(data));
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="grid gap-1.5 text-sm font-medium">
          Token name
          <Input name="name" placeholder="Home Assistant" maxLength={60} className="w-56 font-normal" />
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : "Make a token"}
        </Button>
      </form>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state?.token && (
        <div className="grid gap-2 border-2 border-phosphor p-3 text-sm">
          <p className="font-medium">Copy this token now. It won&apos;t be shown again.</p>
          <Input readOnly value={state.token} aria-label="New token" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" className="w-fit" onClick={() => void navigator.clipboard?.writeText(state.token!).then(() => toast.success("Copied."))}>
            Copy
          </Button>
        </div>
      )}
    </div>
  );
}
