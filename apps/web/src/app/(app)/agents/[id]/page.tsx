import { getBudgetStatus } from "@moss/core";
import { agentRuns, agents, agentSchedules, agentSkills, budgets, models, skills } from "@moss/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill, StatusBadge } from "@/components/badges";
import { SelectField, TextAreaField, TextField } from "@/components/field";
import { Empty, formatUsd, PageHeader, Section, timeAgo } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { describeCron } from "@/lib/schedule";
import { db } from "@/server/db";
import {
  addScheduleAction,
  addSkillAction,
  deleteScheduleAction,
  deleteBudgetAction,
  removeSkillAction,
  runNowAction,
  setBudgetAction,
  setModelAction,
  setScheduleEnabledAction,
  setStatusAction,
  updateScheduleAction,
} from "../actions";
import { ScheduleFields } from "./schedule-fields";

export default async function AgentPage({ params }: PageProps<"/agents/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const [agent] = await db().select().from(agents).where(and(eq(agents.id, id), eq(agents.orgId, user.orgId)));
  if (!agent) notFound();

  const [agentSkillRows, allSkills, runs, budgetRows, schedules, modelRows, budgetStatus, lastScheduledRuns] = await Promise.all([
    db()
      .select({ key: skills.key, name: skills.name, description: skills.description, tools: skills.toolGrants })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(eq(agentSkills.agentId, id)),
    db().select().from(skills).where(eq(skills.orgId, user.orgId)),
    db().select().from(agentRuns).where(eq(agentRuns.agentId, id)).orderBy(desc(agentRuns.startedAt)).limit(15),
    db().select().from(budgets).where(and(eq(budgets.orgId, user.orgId), eq(budgets.agentId, id))),
    db().select().from(agentSchedules).where(eq(agentSchedules.agentId, id)).orderBy(agentSchedules.cron),
    db().select().from(models).where(eq(models.orgId, user.orgId)),
    getBudgetStatus(db(), user.orgId, id),
    // When each schedule last fired (a scheduled run's trigger_ref is its schedule id).
    db()
      .selectDistinctOn([agentRuns.triggerRef], { scheduleId: agentRuns.triggerRef, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, id), eq(agentRuns.trigger, "schedule")))
      .orderBy(agentRuns.triggerRef, desc(agentRuns.startedAt)),
  ]);
  const lastRunOf = (scheduleId: string) => lastScheduledRuns.find((r) => r.scheduleId === scheduleId)?.startedAt;
  // The worker runs schedules in its time zone; web and worker share TZ in the stack.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canManage = user.permissions.has("agents.manage") && agent.status !== "fired";
  const canBudget = user.permissions.has("agents.budget") && agent.status !== "fired";
  const missingSkills = allSkills.filter((s) => !agentSkillRows.some((a) => a.key === s.key));

  return (
    <>
      <PageHeader
        title={agent.name}
        description={
          <span className="flex items-center gap-2">
            {agent.title} <StatusBadge status={agent.status} />
            {agent.pausedReason && agent.status === "paused" && <span className="text-xs">({agent.pausedReason})</span>}
          </span>
        }
        actions={
          <>
            {user.permissions.has("agents.chat") && agent.status === "active" && (
              <Button asChild>
                <Link href={`/agents/${id}/chat`}>Chat</Link>
              </Button>
            )}
            {canManage && (
              <>
              {agent.status === "active" ? (
                <ActionForm action={setStatusAction.bind(null, id, "paused")} submitLabel="Pause" submitVariant="outline" />
              ) : (
                <ActionForm action={setStatusAction.bind(null, id, "active")} submitLabel="Resume" submitVariant="outline" />
              )}
              <ActionForm
                action={setStatusAction.bind(null, id, "fired")}
                submitLabel="Fire"
                submitVariant="destructive"
                confirm={`Fire ${agent.name}? This removes all of their skills, secret access and schedules, and can't be undone.`}
              />
              </>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {canManage && agent.status === "active" && (
            <Card>
              <CardHeader>
                <CardTitle>Give {agent.name} a task</CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm action={runNowAction.bind(null, id)} submitLabel="Start" resetOnSuccess>
                  <TextAreaField label="Task" name="task" rows={3} placeholder="e.g. Find any new devices on the network and identify them." required />
                </ActionForm>
              </CardContent>
            </Card>
          )}

          <Section title="Recent runs" actions={<Link href={`/runs?agent=${id}`} className="text-sm underline">All runs</Link>}>
            {runs.length === 0 ? (
              <Empty>No runs yet.</Empty>
            ) : (
              <ul className="divide-y-2 px-frame">
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link href={`/runs/${r.id}`} className="flex items-start gap-3 p-3 hover:bg-accent">
                      <StatusBadge status={r.status} />
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="text-muted-foreground">
                          {r.trigger} · <span className="font-mono">{timeAgo(r.startedAt)}</span>
                        </div>
                        {r.summary && <p className="line-clamp-2">{r.summary}</p>}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Skills">
            {agentSkillRows.length === 0 ? (
              <Empty>No skills. Without skills, {agent.name} has no tools.</Empty>
            ) : (
              <ul className="divide-y-2 px-frame">
                {agentSkillRows.map((s) => (
                  <li key={s.key} className="flex items-start justify-between gap-4 p-3">
                    <div className="text-sm">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-muted-foreground">{s.description}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{s.tools.join(", ")}</div>
                    </div>
                    {canManage && <ActionForm action={removeSkillAction.bind(null, id, s.key)} submitLabel="Remove" submitVariant="outline" />}
                  </li>
                ))}
              </ul>
            )}
            {canManage && missingSkills.length > 0 && (
              <ActionForm action={addSkillAction.bind(null, id)} submitLabel="Add skill" inline>
                <SelectField label="Skill" name="skill" options={missingSkills.map((s) => ({ value: s.key, label: `${s.name} — ${s.description}` }))} />
              </ActionForm>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Model</CardTitle>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <ActionForm action={setModelAction.bind(null, id)} submitLabel="Save">
                  <SelectField label="Model" name="modelId" defaultValue={agent.modelId ?? undefined} options={modelRows.map((m) => ({ value: m.id, label: m.displayName }))} />
                  <SelectField
                    label="Effort"
                    name="effort"
                    defaultValue={agent.effort}
                    hint="Higher effort is more thorough and costs more tokens."
                    options={["low", "medium", "high", "xhigh", "max"].map((e) => ({ value: e, label: e }))}
                  />
                </ActionForm>
              ) : (
                <p className="text-sm">{modelRows.find((m) => m.id === agent.modelId)?.displayName ?? "None"}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Budgets</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {budgetStatus.checks.length === 0 && <p className="text-muted-foreground">No budget. Without one, only the organisation budget (if any) applies.</p>}
              {budgetStatus.checks.map((c) => {
                const fmt = (n: number) => (c.unit === "usd" ? formatUsd(n) : `${Math.round(n).toLocaleString()} tokens`);
                const pct = Math.min(100, (c.spent / c.hardLimit) * 100);
                const row = budgetRows.find((b) => b.id === c.budgetId);
                return (
                  <div key={c.budgetId} className="space-y-1">
                    <div className="flex justify-between">
                      <span>
                        {c.scope === "global" ? "Organisation" : "Agent"} · per {c.period}
                      </span>
                      <span className="tabular-nums">
                        {fmt(c.spent)} / {fmt(c.hardLimit)}
                      </span>
                    </div>
                    <div className="h-2 rounded bg-muted" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                      <div className={`h-2 rounded ${pct >= 100 ? "bg-alarm" : pct >= 80 ? "bg-amber" : "bg-phosphor"}`} style={{ width: `${pct}%` }} />
                    </div>
                    {row && canBudget && <ActionForm action={deleteBudgetAction.bind(null, row.id)} submitLabel="Remove" submitVariant="outline" />}
                  </div>
                );
              })}
              {canBudget && (
                <ActionForm action={setBudgetAction.bind(null, id)} submitLabel="Set budget">
                  <div className="grid grid-cols-2 gap-2">
                    <SelectField label="Per" name="period" options={[{ value: "day", label: "Day" }, { value: "month", label: "Month" }]} />
                    <SelectField label="Unit" name="unit" options={[{ value: "usd", label: "USD" }, { value: "tokens", label: "Tokens" }]} />
                  </div>
                  <TextField label="Hard limit" name="hardLimit" type="number" step="any" min="0" required hint="The agent is paused when it reaches this." />
                  <TextField label="Soft limit (optional)" name="softLimit" type="number" step="any" min="0" />
                </ActionForm>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Schedules</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              {schedules.length === 0 && <p className="text-muted-foreground">No scheduled tasks. {agent.name} only works when asked.</p>}
              {schedules.map((s) => {
                const lastRun = lastRunOf(s.id);
                return (
                  <div key={s.id} className="grid gap-1.5 border-b-2 pb-4 last:border-b-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={s.enabled ? "font-medium" : "font-medium text-muted-foreground line-through"}>{describeCron(s.cron)}</span>
                      {!s.enabled && <Pill>off</Pill>}
                    </div>
                    <p className="text-muted-foreground">{s.task}</p>
                    <p className="font-mono text-xs text-dim">{lastRun ? `Last ran ${timeAgo(lastRun)}` : "Hasn't run yet"}</p>
                    {canManage && (
                      <div className="flex flex-wrap items-start gap-2">
                        <ActionForm
                          action={setScheduleEnabledAction.bind(null, id, s.id, !s.enabled)}
                          submitLabel={s.enabled ? "Turn off" : "Turn on"}
                          submitVariant="outline"
                        />
                        <ActionForm
                          action={deleteScheduleAction.bind(null, id, s.id)}
                          submitLabel="Delete"
                          submitVariant="outline"
                          confirm={`Delete this schedule? ${agent.name} will stop doing it: ${describeCron(s.cron)}.`}
                        />
                        <details className="basis-full">
                          <summary className="cursor-pointer text-xs text-muted-foreground">Edit</summary>
                          <ActionForm action={updateScheduleAction.bind(null, id, s.id)} submitLabel="Save schedule" className="mt-3">
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
                  <summary className="cursor-pointer font-medium">Add a schedule</summary>
                  <ActionForm action={addScheduleAction.bind(null, id)} submitLabel="Add schedule" resetOnSuccess className="mt-3">
                    <ScheduleFields />
                  </ActionForm>
                </details>
              )}
              <p className="font-mono text-xs text-dim">Times are in {timeZone}.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
