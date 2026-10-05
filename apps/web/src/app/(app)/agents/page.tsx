import { models, skills } from "@moss/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/badges";
import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/field";
import { Empty, formatUsd, PageHeader, Section, timeAgo } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { agentList } from "@/server/queries";
import { library } from "@/server/services";
import { hireAction, hireCustomAction } from "./actions";

export const metadata = { title: "Agents" };

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export default async function AgentsPage() {
  const user = await requireUser();
  const [list, lib, modelRows, skillRows] = await Promise.all([
    agentList(user.orgId),
    library(),
    db().select().from(models).where(eq(models.orgId, user.orgId)),
    db().select().from(skills).where(eq(skills.orgId, user.orgId)).orderBy(skills.name),
  ]);
  const enabledModels = modelRows.filter((m) => m.enabled);
  const canManage = user.permissions.has("agents.manage");
  const team = list.filter((a) => a.status !== "fired");
  const fired = list.filter((a) => a.status === "fired");

  return (
    <>
      <PageHeader title="Agents" description="Your AI team. Hire agents from templates or design your own, give them skills, and set their budgets." />

      <Section title="Team">
        {team.length === 0 ? (
          <Empty>No agents yet. Hire one below.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className="text-right">Spend this month</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link href={`/agents/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{a.title}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={a.status} />
                  </TableCell>
                  <TableCell className="text-sm">{a.modelName ?? "—"}</TableCell>
                  <TableCell className="text-sm">
                    {a.lastRun ? (
                      <span className="flex items-center gap-2">
                        <StatusBadge status={a.lastRun.status} /> {timeAgo(a.lastRun.startedAt)}
                      </span>
                    ) : (
                      "Never"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(a.monthUsd)}
                    <div className="text-xs text-muted-foreground">{a.monthTokens.toLocaleString()} tokens</div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {canManage && (
        <div className="mt-8">
          <Section title="Hire an agent">
            {enabledModels.length === 0 ? (
              <Empty>
                Add a model first: agents need an LLM to think with. <Link href="/models" className="underline">Add a model</Link>
              </Empty>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[...lib.templates.values()].map((t) => (
                  <Card key={t.key}>
                    <CardHeader>
                      <CardTitle>{t.title}</CardTitle>
                      <CardDescription>{t.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="text-xs text-muted-foreground">Skills: {t.skills.join(", ")}</div>
                      <ActionForm action={hireAction} submitLabel={`Hire ${t.defaultName}`}>
                        <input type="hidden" name="templateKey" value={t.key} />
                        <TextField label="Name" name="name" defaultValue={t.defaultName} maxLength={60} />
                        <SelectField
                          label="Model"
                          name="modelId"
                          defaultValue={enabledModels.find((m) => m.modelId === t.suggestedModel)?.id ?? enabledModels[0]!.id}
                          options={enabledModels.map((m) => ({ value: m.id, label: m.displayName }))}
                        />
                      </ActionForm>
                    </CardContent>
                  </Card>
                ))}
                <Card className="md:col-span-2 lg:col-span-3">
                  <CardHeader>
                    <CardTitle>Custom agent</CardTitle>
                    <CardDescription>Design your own role: describe the job, then choose which skills (and so which tools) it gets.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ActionForm action={hireCustomAction} submitLabel="Hire custom agent">
                      <div className="grid gap-4 md:grid-cols-2">
                        <TextField label="Name" name="name" placeholder="Wren" maxLength={60} required />
                        <TextField label="Job title" name="title" placeholder="Backup Admin" maxLength={60} required />
                      </div>
                      <TextAreaField
                        label="Instructions"
                        name="systemPrompt"
                        rows={4}
                        maxLength={8000}
                        required
                        placeholder="You look after backups. Check that the NAS is reachable each morning and raise an incident if it isn't."
                        hint="What the agent is for and how it should work. Skills add their own instructions on top of this."
                      />
                      <fieldset className="grid gap-2">
                        <legend className="mb-2 text-sm font-medium">Skills</legend>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {skillRows.map((s) => (
                            <CheckboxField key={s.key} label={s.name} name="skills" value={s.key} hint={s.description} />
                          ))}
                        </div>
                      </fieldset>
                      <div className="grid gap-4 md:grid-cols-2">
                        <SelectField label="Model" name="modelId" options={enabledModels.map((m) => ({ value: m.id, label: m.displayName }))} />
                        <SelectField label="Effort" name="effort" defaultValue="medium" options={EFFORTS.map((e) => ({ value: e, label: e }))} />
                      </div>
                    </ActionForm>
                  </CardContent>
                </Card>
              </div>
            )}
          </Section>
        </div>
      )}

      {fired.length > 0 && (
        <div className="mt-8">
          <Section title="Former agents">
            <ul className="text-sm text-muted-foreground">
              {fired.map((a) => (
                <li key={a.id}>
                  <Link href={`/agents/${a.id}`} className="hover:underline">
                    {a.name} ({a.title})
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </>
  );
}
