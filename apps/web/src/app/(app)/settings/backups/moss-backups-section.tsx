import { describeBackupSchedule, getSetting, parseBackupSchedule } from "@moss/core";
import { ActionForm } from "@/components/action-form";
import { SelectField, TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { LiveRefresh } from "@/components/live-refresh";
import { Empty, Section, timeAgo } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { backupServiceStatus } from "@/server/backup-service";
import { db } from "@/server/db";
import { DownloadMossBackup } from "./download-dialog";
import { backUpNowAction, deleteMossBackupAction, saveBackupScheduleAction } from "./moss-actions";

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Backups of MOSS itself: back up now, the schedule, and the archives in deploy/backups. */
export async function MossBackupsSection({ orgId }: { orgId: string }) {
  const [status, schedule] = await Promise.all([backupServiceStatus(), getSetting(db(), orgId, "backups.schedule").then(parseBackupSchedule)]);

  return (
    <Section
      title="MOSS backups"
      actions={
        status && (
          <div className="flex flex-wrap gap-2">
            <FormDialog label="Schedule" variant="outline" title="Scheduled backups" description="In this install's time zone. The oldest backups go once there are more than you keep.">
              <ActionForm action={saveBackupScheduleAction} submitLabel="Save schedule">
                <SelectField
                  label="Back up"
                  name="frequency"
                  defaultValue={schedule.frequency}
                  options={[
                    { value: "off", label: "Only when I ask" },
                    { value: "daily", label: "Every day" },
                    { value: "weekly", label: "Every week" },
                  ]}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField label="Day (weekly)" name="weekday" defaultValue={String(schedule.weekday)} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} />
                  <SelectField
                    label="Time"
                    name="hour"
                    defaultValue={String(schedule.hour)}
                    options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))}
                  />
                </div>
                <TextField label="Keep" name="keep" type="number" min={0} max={365} defaultValue={schedule.keep} hint="How many backups to keep. 0 keeps them all." />
              </ActionForm>
            </FormDialog>
            {!status.running && <ActionForm action={backUpNowAction} submitLabel="Back up now" />}
          </div>
        )
      }
    >
      <p className="text-sm text-muted-foreground">
        Everything needed to rebuild MOSS: the database, its secrets (including the master key) and settings, and the HTTPS certificates. They&apos;re
        saved in <code>deploy/backups</code> on the MOSS machine, the same as <code>sh deploy/backup.sh</code> makes. Restore with{" "}
        <code>sh deploy/restore.sh &lt;file&gt;</code>. Copy some to another machine too: a backup on the same disk doesn&apos;t survive the disk.
      </p>
      {!status ? (
        <Empty>
          The backup service isn&apos;t reachable. If this install is older than the backup service, upgrade MOSS (<code>sh deploy/upgrade.sh</code>);
          otherwise check it with <code>docker compose logs backup</code>. <code>sh deploy/backup.sh</code> still works on the host.
        </Empty>
      ) : (
        <>
          <p className="text-sm" aria-live="polite">
            <strong>Schedule:</strong> {describeBackupSchedule(schedule)}
            {schedule.frequency !== "off" && <>, keeping {schedule.keep || "every"} backup{schedule.keep === 1 ? "" : "s"}</>}.{" "}
            {status.running ? (
              <>Backing up now (started {timeAgo(new Date(status.running.startedAt))}).</>
            ) : status.last && !status.last.ok ? (
              <span className="text-destructive">The last backup failed {timeAgo(new Date(status.last.at))}: {status.last.error}</span>
            ) : null}
          </p>
          {status.running && <LiveRefresh everyMs={3000} />}
          {status.backups.length === 0 ? (
            <Empty>No MOSS backups yet. Back up now, or set a schedule.</Empty>
          ) : (
            <div className="px-frame overflow-x-auto">
              <Table aria-label="MOSS backups">
                <TableHeader>
                  <TableRow>
                    <TableHead>Taken</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.backups.map((b) => (
                    <TableRow key={b.name}>
                      <TableCell className="whitespace-nowrap font-mono text-xs" title={new Date(b.created).toLocaleString()}>
                        {timeAgo(new Date(b.created))}
                      </TableCell>
                      <TableCell className="font-mono">{b.name}</TableCell>
                      <TableCell className="text-right font-mono">{size(b.bytes)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <DownloadMossBackup name={b.name} />
                          <ActionForm
                            action={deleteMossBackupAction.bind(null, b.name)}
                            submitLabel="Delete"
                            submitVariant="outline"
                            confirm={`Delete ${b.name}? It can't be brought back.`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
