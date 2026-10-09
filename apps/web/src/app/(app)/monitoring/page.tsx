import { listMonitors } from "@moss/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { FormDialog } from "@/components/form-dialog";
import { Pill, PriorityBadge, StatusBadge } from "@/components/badges";
import { Empty, NoPermission, PageHeader, timeAgo } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SortableHead } from "@/components/sortable-head";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { readSort, sortRows } from "@/lib/sort";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { createMonitorAction } from "./actions";
import { MonitorFields, type MonitorDefaults, type MonitorKind } from "./monitor-fields";
import { describeTarget, formatUptime, monitorFormOptions } from "./shared";

export const metadata = { title: "Monitoring" };

const STATE_ORDER = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 } as const;
const KINDS = new Set(["ping", "tcp", "http", "tls", "dns"]);

/** ?new=1&kind=tcp&target=…&port=…&asset=… pre-fills the form (from an asset's "Monitor" button). */
function prefill(sp: Record<string, string | string[] | undefined>): MonitorDefaults | null {
  if (sp.new !== "1") return null;
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).slice(0, 253) : undefined);
  const kind = KINDS.has(s("kind") ?? "") ? (s("kind") as MonitorKind) : undefined;
  const port = Number(s("port"));
  return { kind, target: s("target"), port: Number.isInteger(port) && port > 0 ? port : undefined, assetId: s("asset"), name: s("name"), scheme: s("scheme") === "https" ? "https" : undefined };
}

export default async function MonitoringPage({ searchParams }: PageProps<"/monitoring">) {
  const user = await requireUser();
  if (!user.permissions.has("monitoring.read")) return <NoPermission />;
  const sp = await searchParams;
  const canManage = user.permissions.has("monitoring.manage");
  const [all, options] = await Promise.all([listMonitors(db(), user.orgId), canManage ? monitorFormOptions(user.orgId) : null]);
  all.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
  const sort = readSort(sp, ["monitor", "state", "result", "uptime", "responder"] as const);
  const rows = sortRows(all, sort, {
    monitor: (m) => m.name,
    state: (m) => STATE_ORDER[m.state],
    result: (m) => m.lastCheckAt,
    uptime: (m) => m.uptime24h,
    responder: (m) => m.responderName,
  });
  const head = (label: string, key: string, className?: string) => <SortableHead label={label} sortKey={key} state={sort} path="/monitoring" sp={sp} className={className} />;
  const counts = Object.fromEntries(Object.keys(STATE_ORDER).map((s) => [s, rows.filter((r) => r.state === s).length])) as Record<keyof typeof STATE_ORDER, number>;
  const defaults = prefill(sp);

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="Keep watch on the services that matter. When one goes down, MOSS raises an incident and its responder agent starts working it."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/monitoring/sources">Webhook sources</Link>
            </Button>
            {canManage && options && (
              <FormDialog
                label="Add a monitor"
                title="Add a monitor"
                description="Checks run from the MOSS toolbox through the policy gate, so the target must be inside an allowed network."
                wide
                defaultOpen={sp.new === "1"}
              >
                <ActionForm action={createMonitorAction} submitLabel="Add monitor">
                  <MonitorFields defaults={defaults ?? undefined} assets={options.assets} responders={options.responders} />
                </ActionForm>
              </FormDialog>
            )}
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        {(
          [
            ["down", "Down", "text-alarm"],
            ["degraded", "Degraded", "text-amber"],
            ["up", "Up", "text-phosphor"],
            ["paused", "Paused", "text-muted-foreground"],
          ] as const
        ).map(([state, label, tone]) => (
          <Card key={state} className="py-4">
            <CardContent className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">{label}</span>
              <span className={`text-2xl font-semibold tabular-nums ${counts[state] ? tone : ""}`}>{counts[state]}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty>
          No monitors yet. Add one with Add a monitor, or connect Uptime Kuma, Beszel or Alertmanager under{" "}
          <Link href="/monitoring/sources" className="underline">
            Webhook sources
          </Link>
          .
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {head("Monitor", "monitor")}
              {head("State", "state")}
              {head("Last result", "result")}
              {head("Uptime 24h", "uptime", "text-right")}
              {head("Responder", "responder")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <Link href={`/monitoring/${m.id}`} className="font-medium hover:underline">
                    {m.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    <span className="uppercase">{m.kind}</span> · <span className="font-mono">{m.kind === "external" ? m.target || "webhook" : describeTarget(m)}</span>
                    {m.assetName && <> · {m.assetName}</>}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={m.state} />
                    {m.lastResult?.flapping && <Pill tone="orange">flapping</Pill>}
                    {m.lastResult?.policyDenied && <Pill tone="red">blocked</Pill>}
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">since {timeAgo(m.stateChangedAt)}</div>
                </TableCell>
                <TableCell className="max-w-xs">
                  <div className="truncate text-sm" title={m.lastResult?.message}>
                    {m.lastResult?.message ?? "Not checked yet"}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">{timeAgo(m.lastCheckAt)}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatUptime(m.uptime24h)}</TableCell>
                <TableCell className="text-sm">
                  <div className="flex items-center gap-2">
                    <PriorityBadge priority={m.priority} />
                    {m.responderName ?? <span className="text-muted-foreground">Nobody</span>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

    </>
  );
}
