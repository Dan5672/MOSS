"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useState } from "react";
import { toast } from "sonner";
import type { FormState } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Sidebar kill switch. `toggle` is the settings toggle action bound to the switch's next value.
 * Pausing asks first; resuming doesn't. Not a role="status" region: the banner already announces it.
 */
export function KillSwitchPanel({ paused, toggle }: { paused: boolean; toggle: (state: FormState) => Promise<FormState> }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, run, pending] = useActionState(async (prev: FormState) => {
    const result = await toggle(prev);
    if (result?.ok) {
      if (result.message) toast.success(result.message);
      router.refresh();
    }
    return result;
  }, undefined);
  const submit = () => startTransition(() => run());

  return (
    <div className={cn("px-frame grid gap-2 p-3", paused && "bg-alarm/10 dark:bg-[#1f1210]")}>
      <div className="flex items-center justify-between font-mono text-[11px]">
        <span className="text-dim">KILL SWITCH</span>
        <span className={cn("flex items-center gap-1.5", paused ? "text-alarm" : "text-phosphor")}>
          <span aria-hidden className={cn("size-2", paused ? "bg-alarm" : "bg-phosphor")} />
          {paused ? "PAUSED" : "RUNNING"}
        </span>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() => (paused ? submit() : setConfirming(true))}
        className={cn(
          "min-h-11 w-full font-mono text-[13px] font-medium text-on-brand disabled:opacity-60",
          paused ? "bg-phosphor" : "bg-alarm",
        )}
      >
        {pending ? "WORKING…" : paused ? "RESUME AGENTS" : "PAUSE ALL AGENTS"}
      </button>
      {state?.error && (
        <p role="alert" className="text-xs text-alarm">
          {state.error}
        </p>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause all agents?</DialogTitle>
            <DialogDescription>Every agent stops straight away and no tool calls run until you resume.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                submit();
              }}
            >
              Pause all agents
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
