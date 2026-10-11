import type { agentSchedules } from "@moss/db";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { timeAgo } from "@/components/page";
import { describeCron } from "@/lib/schedule";
import { addScheduleAction, deleteScheduleAction, setScheduleEnabledAction, updateScheduleAction } from "./actions";
import { ScheduleFields } from "./[id]/schedule-fields";

type Task = typeof agentSchedules.$inferSelect;

/** One agent's recurring tasks: when each runs, what it does, when it last ran, and (to managers) edit controls. */
export function RecurringTaskList({
  agentId,
  agentName,
  tasks,
  lastRun,
  canManage,
}: {
  agentId: string;
  agentName: string;
  tasks: Task[];
  lastRun: (taskId: string) => Date | null | undefined;
  canManage: boolean;
}) {
  return (
    <div className="grid gap-4 text-sm">
      {tasks.length === 0 && <p className="text-muted-foreground">No recurring tasks. {agentName} only works when asked.</p>}
      {tasks.map((s) => {
        const last = lastRun(s.id);
        return (
          <div key={s.id} className="grid gap-1.5 border-b-2 pb-4 last:border-b-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={s.enabled ? "font-medium" : "font-medium text-muted-foreground line-through"}>{describeCron(s.cron)}</span>
              {!s.enabled && <Pill>off</Pill>}
            </div>
            <p className="text-muted-foreground">{s.task}</p>
            <p className="font-mono text-xs text-dim">{last ? `Last ran ${timeAgo(last)}` : "Hasn't run yet"}</p>
            {canManage && (
              <div className="flex flex-wrap items-start gap-2">
                <ActionForm action={setScheduleEnabledAction.bind(null, agentId, s.id, !s.enabled)} submitLabel={s.enabled ? "Turn off" : "Turn on"} submitVariant="outline" />
                <ActionForm
                  action={deleteScheduleAction.bind(null, agentId, s.id)}
                  submitLabel="Delete"
                  submitVariant="outline"
                  confirm={`Delete this recurring task? ${agentName} will stop doing it: ${describeCron(s.cron)}.`}
                />
                <details className="basis-full">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Edit</summary>
                  <ActionForm action={updateScheduleAction.bind(null, agentId, s.id)} submitLabel="Save recurring task" className="mt-3">
                    <ScheduleFields cron={s.cron} task={s.task} />
                  </ActionForm>
                </details>
              </div>
            )}
          </div>
        );
      })}
      {canManage && (
        <details className="border-t-2 pt-4">
          <summary className="cursor-pointer font-medium">Add a recurring task</summary>
          <ActionForm action={addScheduleAction.bind(null, agentId)} submitLabel="Add recurring task" resetOnSuccess className="mt-3">
            <ScheduleFields />
          </ActionForm>
        </details>
      )}
    </div>
  );
}
