import Link from "next/link";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { Empty, formatUsd, PageHeader, Section, timeAgo } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { dashboard } from "@/server/queries";

export const metadata = { title: "Dashboard" };

function Stat({ label, value, sub, href }: { label: string; value: React.ReactNode; sub?: React.ReactNode; href: string }) {
  return (
    <Link href={href} className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <Card className="h-full transition-colors hover:bg-accent/40">
        <CardHeader>
          <CardDescription>{label}</CardDescription>
          <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
        </CardHeader>
        {sub && <CardContent className="text-sm text-muted-foreground">{sub}</CardContent>}
      </Card>
    </Link>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const d = await dashboard(user.orgId);
  const priorities = (["P1", "P2", "P3", "P4"] as const).filter((p) => d.incidents.byPriority[p]);

  return (
    <>
      <PageHeader title="Dashboard" description="What your IT department is doing, at a glance." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Open incidents" value={d.incidents.open} href="/incidents" sub={
          priorities.length ? (
            <span className="flex flex-wrap gap-1">
              {priorities.map((p) => (
                <span key={p} className="flex items-center gap-1">
                  <PriorityBadge priority={p} /> {d.incidents.byPriority[p]}
                </span>
              ))}
            </span>
          ) : "Nothing open"
        } />
        <Stat
          label="Monitors down"
          value={d.monitors.down}
          href="/monitoring"
          sub={d.monitors.total ? `${d.monitors.up} up${d.monitors.degraded ? ` · ${d.monitors.degraded} degraded` : ""}` : "No monitors yet"}
        />
        <Stat label="Awaiting approval" value={d.pendingApprovals} href="/changes" sub="Change requests" />
        <Stat label="Assets" value={d.assets.total} href="/assets" sub={`${d.assets.newThisWeek} new this week`} />
        <Stat label="Agents" value={d.agents.active} href="/agents" sub={d.agents.paused ? `${d.agents.paused} paused` : "All active"} />
        <Stat label="Spend this month" value={formatUsd(d.spend.month)} href="/agents" sub={`${formatUsd(d.spend.today)} today`} />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <Section title="Recent agent runs" actions={<Link href="/runs" className="text-sm underline">All activity</Link>}>
          {d.recentRuns.length === 0 ? (
            <Empty>No agent runs yet. Hire an agent to get started.</Empty>
          ) : (
            <ul className="divide-y rounded-lg border">
              {d.recentRuns.map(({ run, agentName }) => (
                <li key={run.id}>
                  <Link href={`/runs/${run.id}`} className="flex items-start gap-3 p-3 hover:bg-accent/40">
                    <StatusBadge status={run.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {agentName} <span className="font-normal text-muted-foreground">· {run.trigger} · {timeAgo(run.startedAt)}</span>
                      </div>
                      {run.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{run.summary}</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Recent activity" actions={<Link href="/audit" className="text-sm underline">Audit log</Link>}>
          <ul className="divide-y rounded-lg border text-sm">
            {d.recentAudit.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 p-3">
                <span>
                  <span className="font-mono text-xs">{e.action}</span>{" "}
                  <span className="text-muted-foreground">by {e.actorType}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}
