import { agents, providers, secretGrants, secrets } from "@moss/db";
import { BUILT_IN_TOOLS } from "@moss/tools";
import { and, eq, inArray, ne } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/field";
import { Empty, NoPermission, PageHeader, Section, timeAgo } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { SettingsTabs } from "../tabs";
import { deleteSecretAction, saveSecretAction, updateSecretScopeAction } from "./actions";

export const metadata = { title: "Secrets" };

const TYPES = [
  { value: "api_token", label: "API key or token" },
  { value: "password", label: "Password" },
  { value: "snmp_community", label: "SNMP community" },
  { value: "ssh_key", label: "SSH private key" },
  { value: "other", label: "Other" },
];

/** Tools that take a credential, offered first when scoping a secret. */
const CREDENTIAL_TOOLS = [...BUILT_IN_TOOLS.values()].filter((t) => t.manifest.secretArgs?.length).map((t) => t.manifest.name);

function ScopeFields({
  hosts = [],
  tools = [],
  granted = [],
  team,
}: {
  hosts?: string[];
  tools?: string[];
  granted?: string[];
  team: { id: string; name: string; title: string }[];
}) {
  return (
    <>
      <TextAreaField
        label="Use only with these hosts"
        name="hosts"
        rows={2}
        required
        defaultValue={hosts.join(", ")}
        className="font-mono"
        placeholder="10.0.0.1"
        hint="IPs or networks, separated by commas. The gate refuses to send this secret anywhere else."
      />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Use only with these tools</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CREDENTIAL_TOOLS.map((t) => (
            <CheckboxField key={t} label={t} name="tools" value={t} defaultChecked={tools.includes(t)} className="font-mono" />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Leave all unticked to allow any tool, still limited to the hosts above.</p>
      </fieldset>
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
    </>
  );
}

export default async function SecretsPage() {
  const user = await requireUser();
  if (!user.permissions.has("secrets.read")) return <NoPermission />;
  const canManage = user.permissions.has("secrets.manage");

  const [rows, team, providerKeys] = await Promise.all([
    db()
      .select({
        id: secrets.id,
        name: secrets.name,
        type: secrets.type,
        description: secrets.description,
        allowedHosts: secrets.allowedHosts,
        allowedTools: secrets.allowedTools,
        lastRotatedAt: secrets.lastRotatedAt,
      })
      .from(secrets)
      .where(eq(secrets.orgId, user.orgId))
      .orderBy(secrets.name),
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title })
      .from(agents)
      .where(and(eq(agents.orgId, user.orgId), ne(agents.status, "fired")))
      .orderBy(agents.hiredAt),
    db().select({ secretId: providers.apiKeySecretId, name: providers.name }).from(providers).where(eq(providers.orgId, user.orgId)),
  ]);
  const grants = rows.length
    ? await db()
        .select({ secretId: secretGrants.secretId, agentId: secretGrants.agentId })
        .from(secretGrants)
        .where(inArray(secretGrants.secretId, rows.map((r) => r.id)))
    : [];
  const providerOf = (id: string) => providerKeys.find((p) => p.secretId === id)?.name;
  const toolSecrets = rows.filter((r) => !providerOf(r.id));
  const modelKeys = rows.filter((r) => providerOf(r.id));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Secrets are encrypted by the gate and never shown again. Agents refer to them by name, as secret:<name>; only the gate sees the value."
      />
      <SettingsTabs current="/settings/secrets" />

      <div className="grid gap-8 lg:grid-cols-[1fr_24rem]">
        <div className="grid content-start gap-8">
          <Section title="Secrets for tools">
            {toolSecrets.length === 0 ? (
              <Empty>No secrets yet. Add one to let agents use credentialed tools such as unifi_clients or snmp_query.</Empty>
            ) : (
              <ul className="grid gap-3">
                {toolSecrets.map((s) => {
                  const granted = grants.filter((g) => g.secretId === s.id).map((g) => g.agentId);
                  return (
                    <li key={s.id} className="px-frame grid gap-2 bg-card p-4 text-sm">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h3 className="font-mono font-semibold">secret:{s.name}</h3>
                        <Pill>{s.type.replace(/_/g, " ")}</Pill>
                      </div>
                      {s.description && <p className="text-muted-foreground">{s.description}</p>}
                      <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
                        <dt className="text-dim">Hosts</dt>
                        <dd className="font-mono">{s.allowedHosts.length ? s.allowedHosts.join(", ") : <span className="text-amber">any allowed host</span>}</dd>
                        <dt className="text-dim">Tools</dt>
                        <dd className="font-mono">{s.allowedTools.length ? s.allowedTools.join(", ") : "any"}</dd>
                        <dt className="text-dim">Agents</dt>
                        <dd>{granted.length ? team.filter((a) => granted.includes(a.id)).map((a) => a.name).join(", ") : <span className="text-dim">none yet</span>}</dd>
                        <dt className="text-dim">Value set</dt>
                        <dd className="font-mono">{timeAgo(s.lastRotatedAt)}</dd>
                      </dl>
                      {canManage && (
                        <div className="flex flex-wrap items-start gap-2">
                          <ActionForm
                            action={deleteSecretAction.bind(null, s.id)}
                            submitLabel="Delete"
                            submitVariant="outline"
                            confirm={`Delete secret:${s.name}? Agents and tools using it will stop working.`}
                          />
                          <details className="basis-full">
                            <summary className="cursor-pointer text-xs text-muted-foreground">Change scope and agents</summary>
                            <ActionForm action={updateSecretScopeAction.bind(null, s.id)} submitLabel="Save scope" className="mt-3">
                              <ScopeFields hosts={s.allowedHosts} tools={s.allowedTools} granted={granted} team={team} />
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

          {modelKeys.length > 0 && (
            <Section title="Model provider keys">
              <p className="text-sm text-muted-foreground">Used by the gate to call model providers. Manage them on the Models page.</p>
              <ul className="px-frame divide-y-2 text-sm">
                {modelKeys.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 p-3">
                    <span className="font-mono">{s.name}</span>
                    <span className="text-muted-foreground">
                      {providerOf(s.id)} · set <span className="font-mono">{timeAgo(s.lastRotatedAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {canManage && (
          <Section title="Add or rotate a secret">
            <div className="px-frame bg-card p-4">
              <ActionForm action={saveSecretAction} submitLabel="Save secret" resetOnSuccess>
                <TextField label="Name" name="name" required maxLength={64} className="font-mono" placeholder="unifi-api" hint="Saving an existing name replaces its value." />
                <SelectField label="Type" name="type" options={TYPES} />
                <TextField label="Value" name="value" type="password" autoComplete="off" required />
                <TextField label="Description" name="description" maxLength={500} placeholder="Read-only API key for the UniFi console" />
                <ScopeFields team={team} tools={CREDENTIAL_TOOLS.slice(0, 1)} />
              </ActionForm>
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
