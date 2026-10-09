import { changeRef, type ChangeRow, type ChangeStatus } from "@moss/core";
import Link from "next/link";
import { Pill } from "@/components/badges";
import { timeAgo } from "@/components/page";

/** The board's columns, left to right, and the statuses each holds. Finished changes show for 30 days. */
const COLUMNS: { title: string; statuses: ChangeStatus[]; recentOnly?: boolean }[] = [
  { title: "Waiting for approval", statuses: ["draft", "submitted"] },
  { title: "Approved", statuses: ["approved", "scheduled"] },
  { title: "In progress", statuses: ["in_progress", "verifying"] },
  { title: "Done", statuses: ["succeeded", "failed", "rolled_back"], recentOnly: true },
  { title: "Closed without running", statuses: ["rejected", "cancelled"], recentOnly: true },
];

const RISK_TONE = { low: "green", medium: "amber", high: "red" } as const;
const OUTCOME_TONE: Partial<Record<ChangeStatus, "green" | "red" | "orange" | "gray">> = { succeeded: "green", failed: "red", rolled_back: "orange", rejected: "gray", cancelled: "gray" };

export function ChangesBoard({ rows, name }: { rows: ChangeRow[]; name: (id: string | null | undefined, fallback?: string) => string }) {
  const since = Date.now() - 30 * 86_400_000;
  return (
    <div className="flex gap-4 overflow-x-auto pb-2" role="list" aria-label="Changes board">
      {COLUMNS.map((col) => {
        const cards = rows.filter((c) => col.statuses.includes(c.status) && (!col.recentOnly || c.updatedAt.getTime() >= since));
        return (
          <section key={col.title} role="listitem" aria-label={`${col.title}: ${cards.length}`} className="px-frame grid w-72 shrink-0 content-start gap-2 bg-card p-3">
            <h2 className="flex items-center justify-between text-sm font-semibold">
              {col.title} <span className="font-mono text-xs text-dim">{cards.length}</span>
            </h2>
            {cards.length === 0 && <p className="text-xs text-muted-foreground">Nothing here.</p>}
            {cards.map((c) => (
              <Link key={c.id} href={`/changes/${c.id}`} className="grid gap-1.5 border-2 bg-background p-2.5 text-sm hover:border-phosphor">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-dim">{changeRef(c.number)}</span>
                  <Pill tone={RISK_TONE[c.risk]}>{c.risk}</Pill>
                </span>
                <span className="font-medium">{c.title}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {name(c.requestedByAgentId ?? c.requestedByUserId)} · <span className="font-mono">{timeAgo(c.updatedAt)}</span>
                  {c.type !== "normal" && <Pill tone={c.type === "emergency" ? "orange" : "blue"}>{c.type}</Pill>}
                  {OUTCOME_TONE[c.status] && <Pill tone={OUTCOME_TONE[c.status]}>{c.status.replace("_", " ")}</Pill>}
                  {c.postReviewRequired && <Pill tone="orange">review needed</Pill>}
                </span>
              </Link>
            ))}
          </section>
        );
      })}
    </div>
  );
}
