"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { agentPanelAction, type AgentPanel } from "@/app/(app)/basement/actions";
import { sendChatAction } from "@/app/(app)/agents/[id]/chat/actions";
import { ActionForm } from "@/components/action-form";
import { TextAreaField } from "@/components/field";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<string, string> = { said: "said", called: "ran", result: "got", denied: "denied", error: "error" };
const KIND_TONE: Record<string, string> = { said: "text-foreground", called: "text-phosphor", result: "text-muted-foreground", denied: "text-alarm", error: "text-alarm" };

/** What an agent in the Basement is working on, refreshed while it runs, with a box to message them. */
export function AgentPanelDialog({ agentId, onClose }: { agentId: string | null; onClose: () => void }) {
  const [panel, setPanel] = useState<AgentPanel | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const p = await agentPanelAction(agentId).catch(() => null);
      if (stop) return;
      setPanel(p);
      setLoaded(agentId);
      // Follow a run while it's going; a finished one doesn't change.
      if (p?.run?.status === "running") timer = setTimeout(load, 4000);
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [agentId]);

  const current = loaded === agentId ? panel : null;
  const running = current?.run?.status === "running";

  return (
    <Dialog open={!!agentId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{current ? current.agent.name : "Loading…"}</DialogTitle>
          <DialogDescription>
            {current
              ? current.run
                ? `${current.agent.title} · ${running ? "working now" : `last run ${current.run.status}`} (${current.run.trigger === "schedule" ? "recurring task" : current.run.trigger})`
                : `${current.agent.title} · hasn't run yet`
              : "Fetching what they're doing."}
          </DialogDescription>
        </DialogHeader>
        {current && (
          <div className="grid gap-4">
            {current.run?.summary && !running && <p className="px-frame p-3 text-sm whitespace-pre-wrap">{current.run.summary}</p>}
            {current.steps.length > 0 && (
              <ol aria-label={running ? "What they're doing, live" : "What they did"} aria-live={running ? "polite" : undefined} className="grid gap-1.5 font-mono text-xs">
                {current.steps.map((s, i) => (
                  <li key={i} className="flex gap-2 border-l-2 pl-2">
                    <span className="w-12 shrink-0 text-dim">{KIND_LABEL[s.kind]}</span>
                    <span className={cn("break-words whitespace-pre-wrap", KIND_TONE[s.kind])}>{s.text}</span>
                  </li>
                ))}
                {running && <li className="cursor-block pl-3 text-phosphor">▌</li>}
              </ol>
            )}
            <div className="flex flex-wrap gap-4 text-sm">
              {current.run && (
                <Link href={`/runs/${current.run.id}`} className="underline underline-offset-2">
                  The whole run
                </Link>
              )}
              <Link href={`/agents/${current.agent.id}`} className="underline underline-offset-2">
                {current.agent.name}&apos;s page
              </Link>
            </div>
            {current.canChat && (
              <div className="border-t-2 pt-4">
                <ActionForm action={sendChatAction.bind(null, current.agent.id)} submitLabel={`Message ${current.agent.name}`} resetOnSuccess>
                  <TextAreaField label={`Message ${current.agent.name}`} name="message" rows={2} required />
                </ActionForm>
                <p className="mt-2 text-xs text-muted-foreground">
                  They reply in{" "}
                  <Link href={`/agents/${current.agent.id}/chat`} className="underline">
                    your chat with {current.agent.name}
                  </Link>
                  .
                </p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
