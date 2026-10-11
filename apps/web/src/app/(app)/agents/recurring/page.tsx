import { agentRuns, agents, agentSchedules } from "@moss/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { SelectField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Empty, NoPermission, PageHeader, timeAgo } from "@/components/page";
import { SortableHead } from "@/components/sortable-head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cronOccurrences } from "@/lib/cron";
import { describeCron } from "@/lib/schedule";
import { readSort, sortRows } from "@/lib/sort";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { addRecurringTaskAction, deleteScheduleAction, setScheduleEnabledAction, updateScheduleAction } from "../actions";
import { ScheduleFields } from "../[id]/schedule-fields";

export const metadata = { title: "Recurring tasks" };

/** When a task runs next (within the coming year), or null when it's off. */
function nextRun(cron: string, enabled: boolean): Date | null {
  if (!enabled) return null;
  const now = new Date();
  return cronOccurrences(cron, now, new Date(now.getTime() + 366 * 86_400_000), 1)[0] ?? null;
}

const inDays = (d: Date | null) => {
  if (!d) return "—";
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)} min`;
  if (mins < 48 * 60) return `in ${Math.round(mins / 60)} h`;
  return `in ${Math.round(mins / 1440)} days`;
};

/** Every agent's recurring tasks in one list: filter, sort, add, edit, turn off. */
export default async function RecurringTasksPage({ searchParams }: PageProps<"/agents/recurring">) {
  const user = await requireUser();
  if (!user.permissions.has("agents.read")) return <NoPermission />;
  const canManage = user.permissions.has("agents.manage");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase().slice(0, 100) : "";
  const agentFilter = typeof sp.agent === "string" ? sp.agent : "";
  const statusFilter = sp.status === "on" || sp.status === "off" ? sp.status : "";

  const [team, tasks, lastRuns] = await Promise.all([
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title })
      .from(agents)
      .where(and(eq(agents.orgId, user.orgId), ne(agents.status, "fired")))
      .orderBy(asc(agents.name)),
    db().select().from(agentSchedules).where(eq(agentSchedules.orgId, user.orgId)),
    // When each recurring task last ran (its runs' trigger_ref is the task's id).
    db()
      .selectDistinctOn([agentRuns.triggerRef], { taskId: agentRuns.triggerRef, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, user.orgId), eq(agentRuns.trigger, "schedule")))
      .orderBy(agentRuns.triggerRef, desc(agentRuns.startedAt)),
  ]);
  const agentOf = (id: string) => team.find((a) => a.id === id);
  const rows = tasks
    .filter((t) => agentOf(t.agentId))
    .map((t) => ({ ...t, agent: agentOf(t.agentId)!, next: nextRun(t.cron, t.enabled), last: lastRuns.find((r) => r.taskId === t.id)?.startedAt ?? null }))
    .filter((t) => (!agentFilter || t.agentId === agentFilter) && (!statusFilter || (statusFilter === "on") === t.enabled) && (!q || t.task.toLowerCase().includes(q)));
  const sort = readSort(sp, ["task", "agent", "schedule", "next", "last", "status"] as const);
  const sorted = sortRows(rows, sort.key ? sort : { key: "next", dir: "asc" }, {
    task: (t) => t.task,
    agent: (t) => t.agent.name,
    schedule: (t) => describeCron(t.cron),
    next: (t) => t.next?.getTime() ?? Number.MAX_SAFE_INTEGER,
    last: (t) => t.last,
    status: (t) => (t.enabled ? 0 : 1),
  });
  const head = (label: string, key: string) => <SortableHead label={label} sortKey={key} state={sort} path="/agents/recurring" sp={sp} />;
  // The worker runs tasks in its time zone; web and worker share TZ in the stack.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const agentOptions = team.map((a) => ({ value: a.id, label: `${a.name} (${a.title})` }));

  return (
    <>
      <PageHeader
        title="Agents"
        description={`Work your agents do on a timetable, such as a weekly backup check or a daily log review. Times are in ${timeZone}.`}
        actions={
          canManage &&
          team.length > 0 && (
            <FormDialog label="New recurring task" title="New recurring task" description="The agent does this on its own, on the timetable you set.">
              <ActionForm action={addRecurringTaskAction} submitLabel="Add recurring task" resetOnSuccess>
                <SelectField label="Agent" name="agentId" options={agentOptions} />
                <ScheduleFields />
              </ActionForm>
            </FormDialog>
          )
        }
      />

      <form role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <Input name="q" defaultValue={q} placeholder="Search tasks" aria-label="Search tasks" className="max-w-xs" />
        <label className="grid gap-1 text-xs text-muted-foreground">
          Agent
          <select name="agent" defaultValue={agentFilter} className="h-9 border bg-transparent px-2 text-sm text-foreground">
            <option value="">All agents</option>
            {team.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Status
          <select name="status" defaultValue={statusFilter} className="h-9 border bg-transparent px-2 text-sm text-foreground">
            <option value="">On and off</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <Button type="submit" variant="outline">
          Filter
        </Button>
        {(q || agentFilter || statusFilter) && (
          <Link href="/agents/recurring" className="pb-2 text-sm underline">
            Clear
          </Link>
        )}
      </form>

      {sorted.length === 0 ? (
        <Empty>{tasks.length === 0 ? "No recurring tasks yet. Add one with New recurring task." : "No recurring tasks match."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {head("Task", "task")}
              {head("Agent", "agent")}
              {head("Schedule", "schedule")}
              {head("Next run", "next")}
              {head("Last run", "last")}
              {head("Status", "status")}
              {canManage && <TableHead className="text-right">Change</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="max-w-md text-sm whitespace-normal">{t.task}</TableCell>
                <TableCell className="text-sm">
                  <Link href={`/agents/${t.agent.id}`} className="hover:underline">
                    {t.agent.name}
                  </Link>
                </TableCell>
                <TableCell className="text-sm">{describeCron(t.cron)}</TableCell>
                <TableCell className="font-mono text-sm whitespace-nowrap">{inDays(t.next)}</TableCell>
                <TableCell className="font-mono text-sm whitespace-nowrap">{t.last ? timeAgo(t.last) : "never"}</TableCell>
                <TableCell>{t.enabled ? <Pill tone="green">on</Pill> : <Pill>off</Pill>}</TableCell>
                {canManage && (
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      <FormDialog label="Edit" title="Edit recurring task" description={`${t.agent.name}: ${describeCron(t.cron)}`} variant="outline">
                        <ActionForm action={updateScheduleAction.bind(null, t.agentId, t.id)} submitLabel="Save recurring task">
                          <ScheduleFields cron={t.cron} task={t.task} />
                        </ActionForm>
                      </FormDialog>
                      <ActionForm action={setScheduleEnabledAction.bind(null, t.agentId, t.id, !t.enabled)} submitLabel={t.enabled ? "Turn off" : "Turn on"} submitVariant="outline" />
                      <ActionForm
                        action={deleteScheduleAction.bind(null, t.agentId, t.id)}
                        submitLabel="Delete"
                        submitVariant="outline"
                        confirm={`Delete this recurring task? ${t.agent.name} will stop doing it: ${describeCron(t.cron)}.`}
                      />
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
