import { getMonitor, incidentRef, monitorTargetWarning } from "@moss/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill, PriorityBadge, StatusBadge } from "@/components/badges";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { Empty, NoPermission, PageHeader, Section, timeAgo } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { checkNowAction, deleteMonitorAction, setMonitorEnabledAction, updateMonitorAction } from "../actions";
import { MonitorFields } from "../monitor-fields";
import { describeTarget, formatUptime, latencyStats, monitorFormOptions, UptimeStrip } from "../shared";

export default async function MonitorPage({ params }: PageProps<"/monitoring/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.permissions.has("monitoring.read")) return <NoPermission />;
  const m = await getMonitor(db(), user.orgId, id);
  if (!m) notFound();
  const canManage = user.permissions.has("monitoring.manage");
  const external = m.kind === "external";
  const [options, scopeWarning] = await Promise.all([
    canManage ? monitorFormOptions(user.orgId) : null,
    external ? null : monitorTargetWarning(db(), user.orgId, m.target),
  ]);
  const latency = latencyStats(m.results);
  const responder = m.responderAgentId ? `agent:${m.responderAgentId}` : m.responderUserId ? `user:${m.responderUserId}` : "";

  return (
    <>
      <PageHeader
        title={m.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={m.state} />
            {m.lastResult?.flapping && <Pill tone="orange">flapping</Pill>}
            <span className="uppercase">{m.kind}</span> ·{" "}
            <span className="font-mono">{external ? m.target || "webhook" : describeTarget(m)}</span> · since {timeAgo(m.stateChangedAt)}
          </span>
        }
        actions={
          canManage && (
            <>
              {!external && m.enabled && <ActionForm action={checkNowAction.bind(null, id)} submitLabel="Check now" submitVariant="outline" />}
              <ActionForm
                action={setMonitorEnabledAction.bind(null, id, !m.enabled)}
                submitLabel={m.enabled ? "Pause" : "Resume"}
                submitVariant="outline"
              />
              <ActionForm
                action={deleteMonitorAction.bind(null, id)}
                submitLabel="Delete"
                submitVariant="destructive"
                confirm={external ? "Delete this monitor? It is created again if its source sends another alert." : "Delete this monitor and its history?"}
              />
            </>
          )
        }
      />

      {scopeWarning && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>MOSS will not check this target</AlertTitle>
          <AlertDescription>
            {scopeWarning}. Monitors follow the same network rules as agents. Allow the network under{" "}
            <Link href="/networks" className="underline">
              Networks
            </Link>{" "}
            if you own it.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="py-4">
              <CardContent>
                <div className="text-sm text-muted-foreground">Uptime 24h</div>
                <div className="text-2xl font-semibold tabular-nums">{formatUptime(m.uptime24h)}</div>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent>
                <div className="text-sm text-muted-foreground">Latency (avg / p95)</div>
                <div className="text-2xl font-semibold tabular-nums">{latency ? `${latency.avg} / ${latency.p95} ms` : "—"}</div>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent>
                <div className="text-sm text-muted-foreground">Open incident</div>
                <div className="text-lg font-semibold">
                  {m.openIncident ? (
                    <Link href={`/incidents/${m.openIncident.id}`} className="hover:underline">
                      <span className="font-mono">{incidentRef(m.openIncident.number)}</span> <StatusBadge status={m.openIncident.status} />
                    </Link>
                  ) : (
                    "None"
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {!external && (
            <Section title="Last 24 hours">
              <UptimeStrip results={m.results} />
            </Section>
          )}

          <Section title="State changes">
            {m.changes.length === 0 ? (
              <Empty>No state changes yet.</Empty>
            ) : (
              <ol className="divide-y-2 px-frame text-sm">
                {m.changes.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 p-3">
                    <StatusBadge status={c.from} /> → <StatusBadge status={c.to} />
                    {c.suppressed && <Pill tone="blue">during a change</Pill>}
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={c.reason}>
                      {c.reason}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{timeAgo(c.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Recent results">
            {m.results.length === 0 ? (
              <Empty>{external ? "No alerts received yet." : "Not checked yet. The first check runs within a few seconds."}</Empty>
            ) : (
              <ol className="divide-y-2 px-frame text-sm">
                {m.results.slice(0, 30).map((r) => (
                  <li key={r.id} className="flex items-center gap-3 p-2.5">
                    <span className={`size-2 shrink-0 rounded-full ${!r.ok ? "bg-alarm" : r.degraded ? "bg-amber" : "bg-phosphor"}`} aria-label={r.ok ? (r.degraded ? "degraded" : "ok") : "failed"} />
                    <span className="min-w-0 flex-1 truncate" title={r.message}>
                      {r.message}
                    </span>
                    <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">{r.latencyMs !== null ? `${r.latencyMs} ms` : ""}</span>
                    <span className="w-28 text-right font-mono text-xs text-muted-foreground">{timeAgo(r.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Responder</dt>
                <dd className="flex items-center gap-2">
                  <PriorityBadge priority={m.priority} /> {m.responderName ?? "Nobody"}
                </dd>
                <dt className="text-muted-foreground">Asset</dt>
                <dd>{m.assetId ? <Link href={`/assets/${m.assetId}`} className="hover:underline">{m.assetName}</Link> : "—"}</dd>
                {external ? (
                  <>
                    <dt className="text-muted-foreground">Source</dt>
                    <dd>
                      <Link href="/monitoring/sources" className="hover:underline">
                        {m.sourceName}
                      </Link>
                    </dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted-foreground">Interval</dt>
                    <dd>every {m.intervalSeconds}s</dd>
                    <dt className="text-muted-foreground">Thresholds</dt>
                    <dd>
                      down after {m.failureThreshold}, up after {m.recoveryThreshold}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">On recovery</dt>
                <dd>{m.autoResolve ? "resolve incident" : "tell the responder"}</dd>
                <dt className="text-muted-foreground">Last check</dt>
                <dd className="font-mono">{timeAgo(m.lastCheckAt)}</dd>
              </dl>
            </CardContent>
          </Card>

          {canManage && options && (
            <Card>
              <CardHeader>
                <CardTitle>Edit</CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm action={updateMonitorAction.bind(null, id, external)} submitLabel="Save">
                  {external ? (
                    <>
                      <TextField label="Name" name="name" defaultValue={m.name} required />
                      <SelectField label="Asset" name="assetId" defaultValue={m.assetId ?? ""} options={[{ value: "", label: "None" }, ...options.assets]} />
                      <SelectField label="Responder" name="responder" defaultValue={responder} options={options.responders} />
                      <SelectField label="Incident priority" name="priority" defaultValue={m.priority} options={["P1", "P2", "P3", "P4"].map((p) => ({ value: p, label: p }))} />
                      <CheckboxField label="Resolve the incident automatically on recovery" name="autoResolve" defaultChecked={m.autoResolve} />
                    </>
                  ) : (
                    <MonitorFields
                      compact
                      assets={options.assets}
                      responders={options.responders}
                      defaults={{ ...m.config, name: m.name, kind: m.kind as "http", target: m.target, assetId: m.assetId, intervalSeconds: m.intervalSeconds, failureThreshold: m.failureThreshold, recoveryThreshold: m.recoveryThreshold, priority: m.priority, responder, autoResolve: m.autoResolve }}
                    />
                  )}
                </ActionForm>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
