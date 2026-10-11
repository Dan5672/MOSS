"use client";

import Link from "next/link";
import { useState, type DragEvent } from "react";
import { toast } from "sonner";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { TextAreaField } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { approveAction, rejectAction } from "./actions";

export interface BoardCard {
  id: string;
  ref: string;
  title: string;
  status: string;
  risk: "low" | "medium" | "high";
  type: string;
  requester: string;
  updated: string;
  postReviewRequired: boolean;
}

/** The board's columns, left to right, and the statuses each holds. */
export const COLUMNS = [
  { key: "waiting", title: "Waiting for approval", statuses: ["draft", "submitted"] },
  { key: "approved", title: "Approved", statuses: ["approved", "scheduled"] },
  { key: "progress", title: "In progress", statuses: ["in_progress", "verifying"] },
  { key: "done", title: "Done", statuses: ["succeeded", "failed", "rolled_back"], recentOnly: true },
  { key: "closed", title: "Closed without running", statuses: ["rejected", "cancelled"], recentOnly: true },
] as const;

const RISK_TONE = { low: "green", medium: "amber", high: "red" } as const;
const OUTCOME_TONE: Record<string, "green" | "red" | "orange" | "gray"> = { succeeded: "green", failed: "red", rolled_back: "orange", rejected: "gray", cancelled: "gray" };

type Decision = { card: BoardCard; decision: "approve" | "reject" } | null;

/**
 * The changes board. With permission to approve, a change waiting for approval can be dragged to Approved
 * (approve) or to Closed without running (reject); both are confirmed in a dialog, and the server checks
 * everything again. Each such card also has Approve and Reject buttons, for keyboards and touch screens.
 */
export function ChangesBoard({ cards, canApprove }: { cards: BoardCard[]; canApprove: boolean }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pending, setPending] = useState<Decision>(null);
  const movable = (c: BoardCard) => canApprove && c.status === "submitted";

  const drop = (column: string) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const card = cards.find((c) => c.id === e.dataTransfer.getData("text/moss-change"));
    setDragging(null);
    if (!card) return;
    if (column === "approved") setPending({ card, decision: "approve" });
    else if (column === "closed") setPending({ card, decision: "reject" });
    else if (column !== "waiting") toast.info("A change moves on by being carried out. Here you can approve it or reject it.");
  };

  return (
    <>
      <div className="flex gap-4 overflow-x-auto pb-2" role="list" aria-label="Changes board">
        {COLUMNS.map((col) => {
          const list = cards.filter((c) => (col.statuses as readonly string[]).includes(c.status));
          const target = dragging && (col.key === "approved" || col.key === "closed");
          return (
            <section
              key={col.key}
              role="listitem"
              aria-label={`${col.title}: ${list.length}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(col.key);
              }}
              onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
              onDrop={drop(col.key)}
              className={cn(
                "px-frame grid w-72 shrink-0 content-start gap-2 bg-card p-3 transition-colors",
                target && "outline-2 outline-offset-2 outline-dashed outline-phosphor/60",
                over === col.key && target && "bg-accent",
              )}
            >
              <h2 className="flex items-center justify-between text-sm font-semibold">
                {col.title} <span className="font-mono text-xs text-dim">{list.length}</span>
              </h2>
              {list.length === 0 && <p className="text-xs text-muted-foreground">{target ? "Drop here" : "Nothing here."}</p>}
              {list.map((c) => (
                <div
                  key={c.id}
                  draggable={movable(c)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/moss-change", c.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(c.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  className={cn("grid gap-1.5 border-2 bg-background p-2.5 text-sm hover:border-phosphor", movable(c) && "cursor-grab", dragging === c.id && "opacity-50")}
                >
                  <Link href={`/changes/${c.id}`} className="grid gap-1.5" draggable={false}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-dim">{c.ref}</span>
                      <Pill tone={RISK_TONE[c.risk]}>{c.risk}</Pill>
                    </span>
                    <span className="font-medium">{c.title}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {c.requester} · <span className="font-mono">{c.updated}</span>
                      {c.type !== "normal" && <Pill tone={c.type === "emergency" ? "orange" : "blue"}>{c.type}</Pill>}
                      {OUTCOME_TONE[c.status] && <Pill tone={OUTCOME_TONE[c.status]}>{c.status.replace("_", " ")}</Pill>}
                      {c.postReviewRequired && <Pill tone="orange">review needed</Pill>}
                    </span>
                  </Link>
                  {movable(c) && (
                    <span className="flex gap-1.5">
                      <Button type="button" size="sm" variant="outline" onClick={() => setPending({ card: c, decision: "approve" })} aria-label={`Approve ${c.ref}`}>
                        Approve
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setPending({ card: c, decision: "reject" })} aria-label={`Reject ${c.ref}`}>
                        Reject
                      </Button>
                    </span>
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="sm:max-w-lg">
          {pending && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pending.decision === "approve" ? "Approve" : "Reject"} {pending.card.ref}?
                </DialogTitle>
                <DialogDescription>
                  {pending.card.title}.{" "}
                  <Link href={`/changes/${pending.card.id}`} className="underline underline-offset-2">
                    Read exactly what it will do
                  </Link>{" "}
                  before deciding.
                </DialogDescription>
              </DialogHeader>
              {pending.decision === "approve" ? (
                <ActionForm action={async (prev, form) => close(await approveAction(pending.card.id, prev, form))} submitLabel="Approve">
                  <TextAreaField label="Comment (optional)" name="comment" rows={2} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="force" /> Approve even if it conflicts with another change
                  </label>
                </ActionForm>
              ) : (
                <ActionForm action={async (prev, form) => close(await rejectAction(pending.card.id, prev, form))} submitLabel="Reject" submitVariant="destructive">
                  <TextAreaField label="Reason" name="comment" rows={2} required />
                </ActionForm>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );

  /** Closes the dialog once the decision went through (errors stay in the form). */
  function close<T extends { ok?: boolean } | undefined>(result: T): T {
    if (result?.ok) setPending(null);
    return result;
  }
}
