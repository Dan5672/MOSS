import { listMonitorSources } from "@moss/core";
import { agents } from "@moss/db";
import { and, eq, ne } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Pill, PriorityBadge } from "@/components/badges";
import { Empty, NoPermission, PageHeader, timeAgo } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { deleteSourceAction, setSourceEnabledAction } from "../actions";
import { NewSourceForm } from "./new-source-form";
import { workingAgents } from "@/server/people";

export const metadata = { title: "Webhook sources" };

const KIND_LABEL: Record<string, string> = { uptime_kuma: "Uptime Kuma", beszel: "Beszel", alertmanager: "Alertmanager", generic: "Generic JSON", home_assistant: "Home Assistant (module)" };

/** The address this browser used to reach MOSS, so the webhook URL is one that resolves on the LAN. */
async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (process.env.MOSS_SECURE_COOKIES === "true" ? "https" : "http");
  return `${proto}://${host}`;
}

export default async function SourcesPage() {
  const user = await requireUser();
  if (!user.permissions.has("monitoring.read")) return <NoPermission />;
  const canManage = user.permissions.has("monitoring.manage");
  const [rows, agentRows, base] = await Promise.all([
    listMonitorSources(db(), user.orgId),
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title })
      .from(agents)
      .where(and(eq(agents.orgId, user.orgId), ne(agents.status, "fired"), workingAgents)),
    baseUrl(),
  ]);

  return (
    <>
      <PageHeader
        title="Webhook sources"
        description={
          <>
            Let monitoring tools you already run (Uptime Kuma, Beszel, Alertmanager, scripts) report to MOSS. Each alert becomes a monitor, and failures raise incidents for
            its responder. <Link href="/monitoring" className="underline">Back to monitoring</Link>
          </>
        }
      />
      {rows.length === 0 ? (
        <Empty>No sources yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Webhook URL</TableHead>
              <TableHead>Monitors</TableHead>
              <TableHead>Last alert</TableHead>
              {canManage && <TableHead className="text-right">Manage</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="flex items-center gap-2 font-medium">
                    {s.name} {!s.enabled && <Pill tone="gray">disabled</Pill>}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {KIND_LABEL[s.kind]} · default <PriorityBadge priority={s.defaultPriority} />
                  </div>
                </TableCell>
                <TableCell className="max-w-xs truncate font-mono text-xs">{`${base}/api/hooks/monitoring/${s.id}`}</TableCell>
                <TableCell className="tabular-nums">{s.monitorCount}</TableCell>
                <TableCell className="font-mono text-sm">{s.lastReceivedAt ? timeAgo(s.lastReceivedAt) : "never"}</TableCell>
                {canManage && (
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <ActionForm action={setSourceEnabledAction.bind(null, s.id, !s.enabled)} submitLabel={s.enabled ? "Disable" : "Enable"} submitVariant="outline" />
                      <ActionForm
                        action={deleteSourceAction.bind(null, s.id)}
                        submitLabel="Delete"
                        submitVariant="destructive"
                        confirm={`Delete ${s.name}? Its ${s.monitorCount} monitor(s) and their history are deleted too.`}
                      />
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {canManage && (
        <Card className="mt-8 max-w-3xl">
          <CardHeader>
            <CardTitle>Add a source</CardTitle>
            <CardDescription>
              The sender must be able to reach this address: {base}. If it runs on another machine, make MOSS reachable on your LAN (MOSS_WEB_BIND in deploy/.env).
              Alert text is treated as untrusted data and never as instructions to agents.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewSourceForm baseUrl={base} agents={agentRows.map((a) => ({ value: a.id, label: `${a.name} (${a.title})` }))} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
