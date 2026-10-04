import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONES = {
  red: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  blue: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  gray: "bg-muted text-muted-foreground border-border",
} as const;

export type Tone = keyof typeof TONES;

export function Pill({ tone = "gray", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium capitalize", TONES[tone], className)}>
      {children}
    </Badge>
  );
}

const PRIORITY_TONE: Record<string, Tone> = { P1: "red", P2: "orange", P3: "amber", P4: "gray" };
export function PriorityBadge({ priority }: { priority: string }) {
  return <Pill tone={PRIORITY_TONE[priority] ?? "gray"}>{priority}</Pill>;
}

const STATUS_TONE: Record<string, Tone> = {
  // agents
  active: "green",
  paused: "amber",
  fired: "gray",
  // runs
  running: "blue",
  succeeded: "green",
  failed: "red",
  aborted: "orange",
  skipped: "gray",
  // incidents
  new: "blue",
  in_progress: "blue",
  on_hold: "amber",
  resolved: "green",
  closed: "gray",
  // changes
  draft: "gray",
  submitted: "amber",
  approved: "blue",
  rejected: "red",
  scheduled: "blue",
  verifying: "blue",
  rolled_back: "orange",
  cancelled: "gray",
  // networks
  allowed: "green",
  off_limits: "red",
  unknown: "amber",
  missing: "orange",
  retired: "gray",
};

export function StatusBadge({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "gray"}>{status.replace(/_/g, " ")}</Pill>;
}
