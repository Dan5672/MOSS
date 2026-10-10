import { agentRuns, agents, agentSchedules } from "@moss/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { Empty, NoPermission, PageHeader, Section } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { RecurringTaskList } from "../recurring-task-list";

export const metadata = { title: "Recurring tasks" };

/** Every agent's recurring tasks in one place. */
export default async function RecurringTasksPage() {
  const user = await requireUser();
  if (!user.permissions.has("agents.read")) return <NoPermission />;
  const canManage = user.permissions.has("agents.manage");
  const [team, tasks, lastRuns] = await Promise.all([
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title })
      .from(agents)
      .where(and(eq(agents.orgId, user.orgId), ne(agents.status, "fired")))
      .orderBy(asc(agents.name)),
    db().select().from(agentSchedules).where(eq(agentSchedules.orgId, user.orgId)).orderBy(agentSchedules.cron),
    // When each recurring task last ran (its runs' trigger_ref is the task's id).
    db()
      .selectDistinctOn([agentRuns.triggerRef], { taskId: agentRuns.triggerRef, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, user.orgId), eq(agentRuns.trigger, "schedule")))
      .orderBy(agentRuns.triggerRef, desc(agentRuns.startedAt)),
  ]);
  const lastRun = (taskId: string) => lastRuns.find((r) => r.taskId === taskId)?.startedAt;
  // The worker runs tasks in its time zone; web and worker share TZ in the stack.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const total = tasks.length;
  const on = tasks.filter((t) => t.enabled).length;

  return (
    <>
      <PageHeader title="Agents" description="Work your agents do on a timetable, such as a weekly backup check or a daily log review." />
      <p className="mb-6 text-sm text-muted-foreground">
        {total === 0 ? "No recurring tasks yet." : `${total} recurring task${total === 1 ? "" : "s"}, ${on} on.`} Times are in {timeZone}.
      </p>
      {team.length === 0 ? (
        <Empty>No agents yet.</Empty>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          {team.map((a) => (
            <Section
              key={a.id}
              title={a.name}
              actions={
                <Link href={`/agents/${a.id}`} className="text-sm underline underline-offset-2">
                  {a.title}
                </Link>
              }
            >
              <div className="px-frame p-4">
                <RecurringTaskList agentId={a.id} agentName={a.name} tasks={tasks.filter((t) => t.agentId === a.id)} lastRun={lastRun} canManage={canManage} />
              </div>
            </Section>
          ))}
        </div>
      )}
    </>
  );
}
