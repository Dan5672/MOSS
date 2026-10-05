import { changeRef, incidentRef } from "@moss/core";
import Link from "next/link";
import { PriorityBadge } from "@/components/badges";
import { Mascot } from "@/components/mascot";
import { Empty, formatUsd, PageHeader, Section } from "@/components/page";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { dashboard } from "@/server/queries";

export const metadata = { title: "Dashboard" };

type Dashboard = Awaited<ReturnType<typeof dashboard>>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A row of 10 square segments, `ratio` of them filled. */
function SegmentBar({ ratio, fill = "bg-signal", label }: { ratio: number; fill?: string; label: string }) {
  const filled = Math.min(10, Math.max(0, Math.round(ratio * 10)));
  return (
    <div role="img" aria-label={label} className="grid h-2 grid-cols-10 gap-[3px]">
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={i < filled ? fill : "bg-[#d6cdb5] dark:bg-[#1f2a25]"} />
      ))}
    </div>
  );
}

function Stat({ label, value, tone, sub, href, children }: { label: string; value: React.ReactNode; tone?: string; sub?: React.ReactNode; href: string; children?: React.ReactNode }) {
  return (
    <Link href={href} className="px-frame grid content-start gap-2 bg-card p-4 transition-colors hover:bg-accent">
      <span className="font-mono text-[11px] tracking-wider text-dim uppercase">{label}</span>
      <span className={cn("font-mono text-[34px] leading-none tabular-nums", tone ?? "text-foreground")}>{value}</span>
      {sub && <span className="text-[13px] text-muted-foreground">{sub}</span>}
      {children}
    </Link>
  );
}

/** What needs the user, written from the numbers (no model call). */
function Briefing({ d }: { d: Dashboard }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Morning." : hour < 18 ? "Afternoon." : "Evening.";
  const items = [
    d.incidents.open && plural(d.incidents.open, "incident") + " open",
    d.pendingApprovals && `${plural(d.pendingApprovals, "change")} waiting on your sign-off`,
    d.monitors.down && plural(d.monitors.down, "monitor") + " down",
  ].filter(Boolean);
  return (
    <div className="mb-8 flex flex-wrap items-center gap-6">
      <Mascot size={96} blink />
      <div className="relative min-w-0 flex-1">
        {/* Speech bubble tail, pointing at the mascot. */}
        <span aria-hidden className="absolute top-1/2 -left-3 size-3 -translate-y-1/2 bg-beige" />
        <div className="px-frame grid gap-3 bg-beige p-4 text-[17px] text-ink">
          <p>
            {greeting} {items.length ? `${items.join(" · ")}.` : "All quiet. Nothing needs you."}
          </p>
          {(d.oldestPendingChange || d.incidents.open > 0) && (
            <div className="flex flex-wrap gap-2 font-mono text-sm">
              {d.oldestPendingChange && (
                <Link href={`/changes/${d.oldestPendingChange.id}`} className="flex min-h-11 items-center bg-ink px-4 text-[#4dff9a]">
                  Review {changeRef(d.oldestPendingChange.number)}
                </Link>
              )}
              {d.incidents.open > 0 && (
                <Link href="/incidents" className="flex min-h-11 items-center border-2 border-ink px-4 text-ink">
                  Open incidents
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ROLE_GLOW: Record<string, string> = {
  "it-manager": "var(--phosphor)",
  "systems-admin": "var(--amber)",
  "network-admin": "var(--signal)",
  "security-admin": "#ff7ad9",
};

function TeamCard({ agent, killSwitch }: { agent: Dashboard["team"][number]; killSwitch: boolean }) {
  const paused = agent.status === "paused" || killSwitch;
  const status = agent.status === "paused" ? "Paused" : killSwitch ? "Paused · kill switch" : "On shift";
  const b = agent.budget;
  const ratio = b ? b.spent / b.limit : 0;
  return (
    <Link href={`/agents/${agent.id}`} className="px-frame flex gap-3 bg-card p-3 transition-colors hover:bg-accent">
      <Mascot size={48} glow={ROLE_GLOW[agent.templateKey ?? ""] ?? "var(--phosphor)"} className="shrink-0" />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="text-[15px] font-semibold">{agent.name}</span>
          <span className={cn("flex items-center gap-1.5 font-mono text-xs", paused ? "text-amber" : "text-phosphor")}>
            <span aria-hidden className={cn("size-2", paused ? "bg-amber" : "bg-phosphor")} />
            {status}
          </span>
        </div>
        <span className="truncate font-mono text-[11px] text-dim">
          {agent.title} · {[agent.providerName, agent.modelName].filter(Boolean).join(" / ") || "no model"}
        </span>
        <span className="truncate text-sm text-muted-foreground">{agent.lastRun?.summary ?? "No runs yet."}</span>
        {b && (
          <div className="mt-1 grid gap-1">
            <SegmentBar
              ratio={ratio}
              fill={ratio >= 0.9 ? "bg-alarm" : "bg-signal"}
              label={`Budget: ${Math.round(ratio * 100)}% of this ${b.period}'s limit used`}
            />
            <span className="font-mono text-[11px] text-dim">
              {b.unit === "usd" ? `${formatUsd(b.spent)} / ${formatUsd(b.limit)}` : `${Math.round(b.spent).toLocaleString()} / ${b.limit.toLocaleString()} tokens`}{" "}
              this {b.period}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

function age(date: Date) {
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function actionColour(action: string) {
  if (/\.(denied|failed)$/.test(action)) return "text-alarm";
  if (action.startsWith("incident.")) return "text-amber";
  if (action.startsWith("scan.") || action.startsWith("discovery.")) return "text-signal";
  return "text-phosphor";
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export default async function DashboardPage() {
  const user = await requireUser();
  const d = await dashboard(user.orgId);
  const priorities = (["P1", "P2", "P3", "P4"] as const).filter((p) => d.incidents.byPriority[p]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What your IT department is doing, at a glance."
        actions={
          <span className="flex items-center gap-2 font-mono text-sm">
            <span aria-hidden className={cn("size-2.5", !d.monitors.total ? "bg-dim" : d.monitors.down ? "bg-amber" : "bg-phosphor")} />
            {!d.monitors.total ? "No monitors yet" : d.monitors.down ? `${plural(d.monitors.down, "monitor")} down` : "All monitors up"}
          </span>
        }
      />

      <Briefing d={d} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-3">
        <Stat
          label="Open incidents"
          value={d.incidents.open}
          tone={d.incidents.open ? "text-alarm" : undefined}
          href="/incidents"
          sub={
            priorities.length ? (
              <span className="flex flex-wrap gap-1">
                {priorities.map((p) => (
                  <span key={p} className="flex items-center gap-1">
                    <PriorityBadge priority={p} /> {d.incidents.byPriority[p]}
                  </span>
                ))}
              </span>
            ) : (
              "Nothing open"
            )
          }
        />
        <Stat
          label="Monitors down"
          value={d.monitors.down}
          tone={d.monitors.down ? "text-amber" : undefined}
          href="/monitoring"
          sub={d.monitors.total ? `${d.monitors.up} up${d.monitors.degraded ? ` · ${d.monitors.degraded} degraded` : ""}` : "No monitors yet"}
        />
        <Stat label="Awaiting approval" value={d.pendingApprovals} tone={d.pendingApprovals ? "text-phosphor" : undefined} href="/changes" sub="Change requests" />
        <Stat label="Assets" value={d.assets.total} href="/assets" sub={`${d.assets.newThisWeek} new this week`} />
        <Stat label="Agents" value={d.agents.active} href="/agents" sub={d.agents.paused ? `${d.agents.paused} paused` : "All active"} />
        <Stat label="Spend this month" value={formatUsd(d.spend.month)} href="/agents" sub={`${formatUsd(d.spend.today)} today`}>
          {d.monthlyCapUsd !== null && (
            <SegmentBar ratio={d.spend.month / d.monthlyCapUsd} label={`${formatUsd(d.spend.month)} of the ${formatUsd(d.monthlyCapUsd)} monthly cap`} />
          )}
        </Stat>
      </div>

      <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(min(480px,100%),1fr))] gap-8">
        <Section
          title="The team"
          actions={
            <Link href="/agents" className="text-sm underline">
              Hire an agent
            </Link>
          }
        >
          {d.team.length === 0 ? (
            <Empty>No agents yet. Hire one to get started.</Empty>
          ) : (
            <div className="grid gap-2">
              {d.team.map((a) => (
                <TeamCard key={a.id} agent={a} killSwitch={d.killSwitch} />
              ))}
            </div>
          )}
        </Section>

        <div className="grid content-start gap-8">
          <Section
            title="Incident queue"
            actions={
              <Link href="/incidents" className="text-sm underline">
                All incidents
              </Link>
            }
          >
            {d.openIncidentQueue.length === 0 ? (
              <Empty>Nothing open.</Empty>
            ) : (
              <div className="px-frame overflow-x-auto bg-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="font-mono text-[11px] tracking-wider text-dim uppercase">
                      <th className="px-3 py-2 text-left font-normal">ID</th>
                      <th className="px-3 py-2 text-left font-normal">Incident</th>
                      <th className="px-3 py-2 text-left font-normal">Pri</th>
                      <th className="px-3 py-2 text-left font-normal">On it</th>
                      <th className="px-3 py-2 text-right font-normal">Age</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2">
                    {d.openIncidentQueue.map((i) => (
                      <tr key={i.id}>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Link href={`/incidents/${i.id}`} className="font-mono text-ink underline-offset-2 hover:underline dark:text-beige">
                            {incidentRef(i.number)}
                          </Link>
                        </td>
                        <td className="max-w-[16rem] truncate px-3 py-2">{i.title}</td>
                        <td className="px-3 py-2">
                          <PriorityBadge priority={i.priority} />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{i.agentName ?? "—"}</td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-dim">{age(i.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section
            title="Audit tail"
            actions={
              <Link href="/audit" className="text-sm underline">
                Audit log
              </Link>
            }
          >
            {/* Always the dark CRT look, whatever the theme. */}
            <div className="dark px-frame scanlines overflow-x-auto bg-terminal p-3 font-mono text-[13px] text-foreground">
              <ol className="grid gap-1">
                {d.recentAudit.map((e) => (
                  <li key={e.id} className="whitespace-nowrap">
                    <span className="text-dim">{clock.format(e.createdAt)}</span> <span className={actionColour(e.action)}>{e.action}</span>
                    {e.targetType && (
                      <span className="text-muted-foreground">
                        {" "}
                        {e.targetType}
                        {e.targetId && ` ${e.targetId.slice(0, 8)}`}
                      </span>
                    )}{" "}
                    <span className="text-dim">· {e.actorName ?? e.actorType}</span>
                  </li>
                ))}
                <li aria-hidden className="flex items-center gap-2 text-phosphor">
                  &gt; <span className="cursor-block inline-block h-4 w-[9px] bg-phosphor" />
                </li>
              </ol>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

