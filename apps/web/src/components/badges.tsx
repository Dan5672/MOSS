import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Square, outlined, mono. Brand tokens are darkened on the light theme to keep 4.5:1 contrast.
const TONES = {
  red: "text-alarm border-alarm",
  orange: "text-amber border-amber",
  amber: "text-amber border-amber",
  green: "text-phosphor border-phosphor",
  blue: "text-signal border-signal",
  gray: "text-dim border-dim",
} as const;

export type Tone = keyof typeof TONES;

export function Pill({ tone = "gray", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-none border-2 bg-transparent font-mono text-xs font-medium capitalize", TONES[tone], className)}>
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
  // monitors
  up: "green",
  degraded: "amber",
  down: "red",
  pending: "gray",
};

export function StatusBadge({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "gray"}>{status.replace(/_/g, " ")}</Pill>;
}
