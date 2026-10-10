import { agents, customToolGrants, customTools, secrets } from "@moss/db";
import { customToolSpecSchema, targetParam } from "@moss/tools";
import { and, eq, inArray, ne } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { CheckboxField, TextAreaField } from "@/components/field";
import { Empty, NoPermission, PageHeader, Section, timeAgo } from "@/components/page";
import { requireUser } from "@/server/auth";
import { EXAMPLE_CUSTOM_TOOL } from "@/server/custom-tools";
import { db } from "@/server/db";
import { AgentsTabs } from "../tabs";
import { addCustomToolAction, deleteCustomToolAction, setCustomToolEnabledAction, updateCustomToolAction } from "./actions";

export const metadata = { title: "Custom tools" };

function AgentChoices({ team, granted = [] }: { team: { id: string; name: string; title: string }[]; granted?: string[] }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Agents that may use it</legend>
      {team.length === 0 ? (
        <p className="text-xs text-muted-foreground">No agents yet.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {team.map((a) => (
            <CheckboxField key={a.id} label={`${a.name} (${a.title})`} name="agents" value={a.id} defaultChecked={granted.includes(a.id)} />
          ))}
        </div>
      )}
    </fieldset>
  );
}

export default async function CustomToolsPage() {
  const user = await requireUser();
  if (!user.permissions.has("agents.read")) return <NoPermission />;
  const canManage = user.permissions.has("tools.manage");
  const [rows, team, secretRows] = await Promise.all([
    db().select().from(customTools).where(eq(customTools.orgId, user.orgId)).orderBy(customTools.key),
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title })
      .from(agents)
      .where(and(eq(agents.orgId, user.orgId), ne(agents.status, "fired")))
      .orderBy(agents.hiredAt),
    db().select({ name: secrets.name }).from(secrets).where(eq(secrets.orgId, user.orgId)),
  ]);
  const grants = rows.length
    ? await db()
        .select({ toolId: customToolGrants.toolId, agentId: customToolGrants.agentId })
        .from(customToolGrants)
        .where(inArray(customToolGrants.toolId, rows.map((r) => r.id)))
    : [];

  return (
    <>
      <PageHeader
        title="Agents"
        description="Your own HTTP tools, defined in YAML or JSON. They run through the policy gate like built-in tools: allowed networks only, write tools need an approved change, secrets stay in the gate, and every call is audited. No code runs."
      />
      <AgentsTabs current="/agents/custom-tools" />

      <div className="grid gap-8 lg:grid-cols-[1fr_28rem]">
        <Section title="Custom tools">
          {rows.length === 0 ? (
            <Empty>No custom tools yet.</Empty>
          ) : (
            <ul className="grid gap-3">
              {rows.map((row) => {
                const parsed = customToolSpecSchema.safeParse(row.spec);
                const granted = grants.filter((g) => g.toolId === row.id).map((g) => g.agentId);
                const spec = parsed.success ? parsed.data : null;
                const missingSecret = spec?.secret && !secretRows.some((s) => s.name === spec.secret);
                return (
                  <li key={row.id} className="px-frame grid gap-2 bg-card p-4 text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <h3 className="font-mono font-semibold">{row.key}</h3>
                      {spec && <Pill tone={spec.class === "write" ? "orange" : "gray"}>{spec.class}</Pill>}
                      {!row.enabled && <Pill>off</Pill>}
                      {!spec && <Pill tone="red">invalid</Pill>}
                    </div>
                    {spec && (
                      <>
                        <p className="text-muted-foreground">{spec.description}</p>
                        <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
                          <dt className="text-dim">Request</dt>
                          <dd className="font-mono break-all">
                            {spec.request.method} {spec.request.scheme}://{`{${targetParam(spec)}}`}
                            {spec.request.port ? `:${spec.request.port}` : ""}
                            {spec.request.path}
                          </dd>
                          <dt className="text-dim">Secret</dt>
                          <dd className="font-mono">
                            {spec.secret ? `secret:${spec.secret}` : "none"}
                            {missingSecret && <span className="ml-2 font-sans text-amber">not stored yet: add it under Settings → Secrets</span>}
                          </dd>
                          <dt className="text-dim">Agents</dt>
                          <dd>
                            {granted.length ? (
                              team
                                .filter((a) => granted.includes(a.id))
                                .map((a) => a.name)
                                .join(", ")
                            ) : (
                              <span className="text-dim">none</span>
                            )}
                          </dd>
                          <dt className="text-dim">Updated</dt>
                          <dd className="font-mono">{timeAgo(row.updatedAt)}</dd>
                        </dl>
                      </>
                    )}
                    {canManage && (
                      <div className="flex flex-wrap items-start gap-2">
                        <ActionForm
                          action={setCustomToolEnabledAction.bind(null, row.id, !row.enabled)}
                          submitLabel={row.enabled ? "Turn off" : "Turn on"}
                          submitVariant="outline"
                        />
                        <ActionForm
                          action={deleteCustomToolAction.bind(null, row.id)}
                          submitLabel="Delete"
                          submitVariant="outline"
                          confirm={`Delete ${row.key}? Agents lose it immediately.`}
                        />
                        <details className="basis-full">
                          <summary className="cursor-pointer text-xs text-muted-foreground">Edit definition and agents</summary>
                          <ActionForm action={updateCustomToolAction.bind(null, row.id)} submitLabel="Save tool" className="mt-3">
                            <TextAreaField label="Definition" name="source" rows={16} defaultValue={row.source} required className="font-mono text-xs" spellCheck={false} />
                            <AgentChoices team={team} granted={granted} />
                          </ActionForm>
                        </details>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {canManage && (
          <Section title="Add a custom tool">
            <div className="px-frame grid gap-3 bg-card p-4">
              <p className="text-xs text-muted-foreground">
                One parameter must be the target IP. Read tools use GET; anything that changes state is a write tool and needs an approved
                change request each time. <span className="font-mono">{"{{secret}}"}</span> is filled in by the gate from the named secret, which
                must be granted to the agent and scoped to the host and this tool.
              </p>
              <ActionForm action={addCustomToolAction} submitLabel="Add tool" resetOnSuccess>
                <TextAreaField label="Definition" name="source" rows={20} defaultValue={EXAMPLE_CUSTOM_TOOL} required className="font-mono text-xs" spellCheck={false} />
                <AgentChoices team={team} />
              </ActionForm>
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
