import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/badges";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { NoPermission, PageHeader, timeAgo } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { integrationOrNull, integrationPage } from "@/server/integrations";
import { saveIntegrationConnectionAction, saveIntegrationFeaturesAction, setIntegrationEnabledAction, syncIntegrationFeatureAction, testIntegrationAction } from "./actions";

/** One integration's settings: its connection and credential, its features, and how each last ran. */
export default async function IntegrationSettingsPage({ params }: PageProps<"/settings/integrations/[key]">) {
  const user = await requireUser();
  if (!user.permissions.has("integrations.manage")) return <NoPermission />;
  const def = integrationOrNull((await params).key);
  if (!def) notFound();
  const p = await integrationPage(user.orgId, def);
  const c = p.config;
  const connected = !!c.host && !!p.credential;
  const canSecrets = user.permissions.has("secrets.manage");

  return (
    <>
      <PageHeader
        title={def.name}
        description={def.description}
        trail={[
          { href: "/settings", label: "Settings" },
          { href: "/settings/integrations", label: "Integrations" },
        ]}
        actions={
          <ActionForm
            action={setIntegrationEnabledAction.bind(null, def.key, !p.enabled)}
            submitLabel={p.enabled ? "Switch integration off" : "Switch integration on"}
            submitVariant={p.enabled ? "outline" : "default"}
            confirm={p.enabled ? `Switch ${def.name} off? Its health checks and syncs stop.` : undefined}
          />
        }
      />
      {!p.enabled && (
        <p role="status" className="mb-6 border-2 p-3 text-sm">
          The integration is off. Set up the connection and test it first; nothing runs until you switch it on.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card id="connection" className="scroll-mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Connection <Badge variant={connected ? "default" : "outline"}>{connected ? "Set up" : "Not set up"}</Badge>
            </CardTitle>
            <CardDescription>
              {def.connection.hint} It must be on an allowed network. The {def.credential.label.toLowerCase()} is stored encrypted as{" "}
              <code>secret:{def.credential.secretName}</code>, usable only against this address.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ActionForm action={saveIntegrationConnectionAction.bind(null, def.key)} submitLabel="Save connection">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Address" name="host" defaultValue={c.host} placeholder="192.168.1.10" required />
                <TextField label="Port" name="port" type="number" min={1} max={65535} defaultValue={c.port} />
                {def.connection.scheme && (
                  <SelectField
                    label="Scheme"
                    name="scheme"
                    defaultValue={c.scheme}
                    options={[
                      { value: "https", label: "https" },
                      { value: "http", label: "http" },
                    ]}
                  />
                )}
                {def.connection.user && <TextField label={def.connection.user.label} name="user" defaultValue={c.user} required />}
              </div>
              <TextField
                label={def.credential.label}
                name="credential"
                type="password"
                autoComplete="off"
                placeholder={p.credential ? "Saved. Leave blank to keep it." : undefined}
                hint={def.credential.hint}
                disabled={!canSecrets}
              />
              <CheckboxField label="Check its certificate" name="verifyTls" defaultChecked={c.verifyTls} hint="Leave off for the self-signed certificate most home lab devices have." />
              {!canSecrets && <p className="text-sm text-muted-foreground">Changing the connection also needs permission to manage secrets.</p>}
            </ActionForm>
            {connected && <ActionForm action={testIntegrationAction.bind(null, def.key)} submitLabel="Test connection" submitVariant="outline" />}
          </CardContent>
        </Card>

        <Card id="features" className="scroll-mt-6">
          <CardHeader>
            <CardTitle>Features</CardTitle>
            <CardDescription>Each runs in the background on its own schedule while the integration is on. Problems become incidents.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveIntegrationFeaturesAction.bind(null, def.key)} submitLabel="Save features">
              {def.features.map((f) => (
                <CheckboxField key={f.key} label={f.label} name={`feature:${f.key}`} defaultChecked={c.features[f.key]} hint={f.description} />
              ))}
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Incident priority" name="priority" defaultValue={c.priority} options={["P1", "P2", "P3", "P4"].map((v) => ({ value: v, label: v }))} />
                <SelectField
                  label="Responder"
                  name="responderAgentId"
                  defaultValue={c.responderAgentId ?? ""}
                  options={[{ value: "", label: "Nobody (incidents are unassigned)" }, ...p.agents.map((a) => ({ value: a.id, label: `${a.name} (${a.title})` }))]}
                />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card id="status" className="scroll-mt-6 lg:col-span-2">
          <CardHeader>
            <CardTitle>Last runs</CardTitle>
            <CardDescription>What each feature found the last time it ran. Sync now runs one straight away.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ul className="grid gap-2 text-sm" aria-label="Last runs">
              {def.features.map((f) => {
                const run = p.state.runs?.[f.key];
                return (
                  <li key={f.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b-2 pb-2">
                    <span className="font-medium">{f.label}</span>
                    {run ? (
                      <>
                        <Badge variant={run.ok ? "default" : "destructive"}>{run.ok ? "OK" : "Failed"}</Badge>
                        <span className="min-w-0 flex-1 text-muted-foreground">{run.summary}</span>
                        <span className="font-mono text-xs text-muted-foreground">{timeAgo(new Date(run.at))}</span>
                      </>
                    ) : (
                      <span className="flex-1 text-muted-foreground">{c.features[f.key] ? "Not run yet." : "Off."}</span>
                    )}
                    {p.enabled && connected && <ActionForm action={syncIntegrationFeatureAction.bind(null, def.key, f.key)} submitLabel="Sync now" submitVariant="outline" inline />}
                  </li>
                );
              })}
            </ul>
            {p.monitors.length > 0 && (
              <div className="grid gap-1 text-sm">
                <p className="font-medium">Its monitors</p>
                <ul className="flex flex-wrap gap-2">
                  {p.monitors.map((m) => (
                    <li key={m.id}>
                      <Link href={`/monitoring/${m.id}`} className="inline-flex items-center gap-1.5 border-2 px-2 py-1 hover:bg-accent">
                        {m.name} <StatusBadge status={m.state} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {def.agentTools.length > 0 && (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>For agents</CardTitle>
              <CardDescription>
                Agents can use these tools with <code>secret:{def.credential.secretName}</code> once you grant them the tools (
                <Link href="/agents/tools" className="underline underline-offset-2">
                  Agents → Tool access
                </Link>
                ) and the secret (
                <Link href="/settings/secrets" className="underline underline-offset-2">
                  Settings → Secrets
                </Link>
                ). Tools that change something only run in an approved change.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-sm">{def.agentTools.join(", ")}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
