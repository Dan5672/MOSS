import { agentRuns, agents } from "@moss/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { StatusBadge } from "@/components/badges";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { SortableHead } from "@/components/sortable-head";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { readSort, sortRows } from "@/lib/sort";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

export const metadata = { title: "Agent activity" };

export default async function RunsPage({ searchParams }: PageProps<"/runs">) {
  const user = await requireUser();
  if (!user.permissions.has("agents.read")) return <NoPermission />;
  const sp = await searchParams;
  const agentFilter = sp.agent;
  const agentId = typeof agentFilter === "string" ? agentFilter : undefined;
  const latest = await db()
    .select({ run: agentRuns, agentName: agents.name })
    .from(agentRuns)
    .innerJoin(agents, eq(agentRuns.agentId, agents.id))
    .where(and(eq(agentRuns.orgId, user.orgId), agentId ? eq(agentRuns.agentId, agentId) : undefined))
    .orderBy(desc(agentRuns.startedAt))
    .limit(100);
  const sort = readSort(sp, ["when", "agent", "trigger", "status"] as const);
  const rows = sortRows(latest, sort, { when: (r) => r.run.startedAt, agent: (r) => r.agentName, trigger: (r) => r.run.trigger, status: (r) => r.run.status });
  const head = (label: string, key: string) => <SortableHead label={label} sortKey={key} state={sort} path="/runs" sp={sp} />;

  return (
    <>
      <PageHeader title="Agent activity" description="Every agent run, with each step it took." />
      {rows.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {head("When", "when")}
              {head("Agent", "agent")}
              {head("Trigger", "trigger")}
              {head("Status", "status")}
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ run, agentName }) => (
              <TableRow key={run.id}>
                <TableCell className="whitespace-nowrap text-sm">
                  <Link href={`/runs/${run.id}`} className="hover:underline">
                    <span className="font-mono">{timeAgo(run.startedAt)}</span>
                  </Link>
                </TableCell>
                <TableCell className="text-sm">{agentName}</TableCell>
                <TableCell className="text-sm">{run.trigger === "schedule" ? "recurring task" : run.trigger}</TableCell>
                <TableCell>
                  <StatusBadge status={run.status} />
                </TableCell>
                <TableCell className="max-w-md truncate text-sm text-muted-foreground">{run.summary}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
