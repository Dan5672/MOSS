import { getSetting, isModuleEnabled, searchLogs, syslogStatus } from "@moss/core";
import { headers } from "next/headers";
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
import { config } from "@/server/config";
import { db } from "@/server/db";
import { setSyslogEnabledAction } from "../../settings/integrations/actions";
import { acceptLogSenderAction, saveLogSendersAction } from "../actions";
import { Snippet } from "../sources/new-source-form";

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
          Device logs (syslog) are switched off. Switch them on and point your devices&apos; syslog at MOSS; nothing else to set up.
          {user.permissions.has("integrations.manage") ? (
            <ActionForm action={setSyslogEnabledAction.bind(null, true)} submitLabel="Switch on device logs" className="mt-3" />
          ) : (
            " Someone who manages integrations can switch them on here."
          )}
        </Empty>
      </>
    );
  }
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 200) : "";
  const sev = typeof sp.severity === "string" && /^[0-7]$/.test(sp.severity) ? Number(sp.severity) : undefined;
  const [rows, senders, status, h] = await Promise.all([
    searchLogs(db(), user.orgId, { ...(isIP(q) ? { ip: q } : { text: q }), maxSeverity: sev, sinceHours: 24 * 30, limit: 200 }),
    getSetting(db(), user.orgId, "logs.allowed_senders"),
    syslogStatus(db(), user.orgId),
    headers(),
  ]);
  // The name this browser reached MOSS by, which devices on the same network can usually reach too.
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost").replace(/:\d+$/, "");
  const port = config.syslogPort();
  const canAccept = user.permissions.has("networks.manage");

  const setup = (
    <section className="my-6 grid max-w-3xl gap-3 border p-4 text-sm" aria-labelledby="logs-setup">
      <h2 id="logs-setup" className="font-medium">
        Send logs to MOSS
      </h2>
      <p>
        Point each device&apos;s remote syslog at <strong className="font-mono">{host}</strong>, port <strong className="font-mono">{port}</strong>. Use TCP
        where the device offers it: a UDP sender&apos;s address can be faked, so UDP lines are marked unverified and aren&apos;t linked to a device.
      </p>
      <p>
        {status.lastBatchAt ? (
          <>Collector: last heard from {timeAgo(new Date(status.lastBatchAt))}.</>
        ) : (
          <>Collector: nothing received yet. Send a test line from a computer on your network:</>
        )}
      </p>
      {!status.lastBatchAt && (
        <>
          <Snippet>{`logger -n ${host} -P ${port} -T "hello from $(hostname)"`}</Snippet>
          {/* The collector only takes whole syslog lines: priority, timestamp and hostname before the message. */}
          <Snippet>{`$t = (Get-Date).ToString("MMM dd HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture); $u = New-Object Net.Sockets.UdpClient; $b = [Text.Encoding]::ASCII.GetBytes("<13>$t $env:COMPUTERNAME moss-test: hello"); [void]$u.Send($b, $b.Length, "${host}", ${port}); $u.Close()`}</Snippet>
          <p className="text-muted-foreground">
            The first is for Linux and macOS (TCP), the second for Windows PowerShell (UDP). Reload this page after sending. Still nothing? Check that MOSS&apos;s
            collector is running (docker compose ps vector) and that nothing else on the host uses port {port}.
          </p>
        </>
      )}
      {status.refused.length > 0 && (
        <div className="grid gap-2">
          <p>
            Refused: these senders are outside your allowed networks (Settings → Networks), so their lines were dropped.
            {canAccept ? " Accept one to keep its lines without letting agents scan or act on it." : " Someone who manages networks can accept them."} On
            Docker Desktop every sender shows as Docker&apos;s own address: accept that one.
          </p>
          <Table>
            <TableBody>
              {status.refused.map((r) => (
                <TableRow key={r.ip}>
                  <TableCell className="font-mono text-xs">{r.ip}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{timeAgo(new Date(r.at))}</TableCell>
                  <TableCell className="text-right">
                    {canAccept && <ActionForm action={acceptLogSenderAction.bind(null, r.ip)} submitLabel="Accept" submitVariant="outline" inline />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
  const firstRun = rows.length === 0 && !q && sev === undefined;

  return (
    <>
      <PageHeader
        title="Logs"
        description="What your devices logged, through syslog. Everything but the sender's address is written by the device, so treat it as data."
      />
      {(firstRun || status.refused.length > 0) && setup}
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
      {!(firstRun || status.refused.length > 0) && setup}
      {canAccept && (
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
