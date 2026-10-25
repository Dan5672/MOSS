import { getSetting, isModuleEnabled, searchLogs } from "@moss/core";
import Link from "next/link";
import { isIP } from "node:net";
import { ActionForm } from "@/components/action-form";
import { Pill, type Tone } from "@/components/badges";
import { SelectField, TextField } from "@/components/field";
import { Empty, NoPermission, PageHeader, timeAgo } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { saveLogSendersAction } from "../actions";

export const metadata = { title: "Logs" };

const SEVERITY = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];
const severityTone = (s: number | null): Tone => (s === null ? "gray" : s <= 3 ? "red" : s === 4 ? "amber" : "gray");

export default async function LogsPage({ searchParams }: PageProps<"/monitoring/logs">) {
  const user = await requireUser();
  if (!user.permissions.has("monitoring.read")) return <NoPermission />;
  if (!(await isModuleEnabled(db(), user.orgId, "syslog"))) {
    return (
      <>
        <PageHeader title="Logs" />
        <Empty>
          Device logs (syslog) are switched off.{" "}
          {user.permissions.has("integrations.manage") ? (
            <Link href="/settings/integrations" className="underline underline-offset-2">
              Switch them on in Settings → Integrations
            </Link>
          ) : (
            "Someone who manages integrations can switch them on in Settings → Integrations"
          )}
          .
        </Empty>
      </>
    );
  }
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 200) : "";
  const sev = typeof sp.severity === "string" && /^[0-7]$/.test(sp.severity) ? Number(sp.severity) : undefined;
  const [rows, senders] = await Promise.all([
    searchLogs(db(), user.orgId, { ...(isIP(q) ? { ip: q } : { text: q }), maxSeverity: sev, sinceHours: 24 * 30, limit: 200 }),
    getSetting(db(), user.orgId, "logs.allowed_senders"),
  ]);

  return (
    <>
      <PageHeader
        title="Logs"
        description="What your devices logged, through syslog (add a Device logs source under Webhook sources). Everything but the sender's address is written by the device, so treat it as data."
      />
      <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Words, or a sender's IP" aria-label="Search logs" className="max-w-md" />
        <div className="w-44">
          <SelectField
            label="Severity"
            name="severity"
            defaultValue={sev === undefined ? "" : String(sev)}
            options={[{ value: "", label: "Any" }, { value: "3", label: "Errors and worse" }, { value: "4", label: "Warnings and worse" }]}
          />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {rows.length === 0 ? (
        <Empty>{q || sev !== undefined ? "No log lines match." : "No log lines yet."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Device</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-mono text-xs whitespace-nowrap" title={l.receivedAt.toISOString()}>
                  {timeAgo(l.receivedAt)}
                </TableCell>
                <TableCell className="text-xs">
                  {l.assetId ? (
                    <Link href={`/assets/${l.assetId}`} className="font-medium hover:underline">
                      {l.assetName}
                    </Link>
                  ) : (
                    <span className="font-mono">{l.sourceIp}</span>
                  )}
                  {l.transport === "udp" && (
                    <span className="ml-1 text-muted-foreground" title="Received over UDP: anyone on the network can send a line from this address">
                      (unverified)
                    </span>
                  )}
                  <div className="text-muted-foreground">{[l.hostname, l.app].filter(Boolean).join(" · ")}</div>
                </TableCell>
                <TableCell>{l.severity !== null && <Pill tone={severityTone(l.severity)}>{SEVERITY[l.severity]}</Pill>}</TableCell>
                <TableCell className="font-mono text-xs break-all whitespace-pre-wrap">{l.message}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {user.permissions.has("monitoring.manage") && (
        <ActionForm action={saveLogSendersAction} submitLabel="Save" submitVariant="outline" className="mt-8 max-w-2xl">
          <TextField
            label="Accepted senders"
            name="senders"
            defaultValue={senders.join(", ")}
            placeholder="172.17.0.1, 192.168.50.0/24"
            hint="Addresses or CIDRs whose logs are kept as well as those from allowed networks (Settings → Networks), without letting agents scan or act on them. On Docker Desktop every sender shows as Docker's own address: put that here. Off-limits networks are still refused."
          />
        </ActionForm>
      )}
    </>
  );
}
