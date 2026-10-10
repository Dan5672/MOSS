import { agents, configBackups } from "@moss/db";
import { desc, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { Empty, NoPermission, PageHeader, Section, timeAgo } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { SettingsTabs } from "../tabs";
import { deleteBackupAction } from "./actions";

export const metadata = { title: "Backups" };

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function BackupsPage() {
  const user = await requireUser();
  // Backups can contain passwords, so they get the same permission as managing secrets.
  if (!user.permissions.has("secrets.manage")) return <NoPermission />;
  const rows = await db()
    .select({
      id: configBackups.id,
      target: configBackups.target,
      source: configBackups.source,
      filename: configBackups.filename,
      bytes: configBackups.bytes,
      sha256: configBackups.sha256,
      createdAt: configBackups.createdAt,
      agentName: agents.name,
    })
    .from(configBackups)
    .leftJoin(agents, eq(agents.id, configBackups.agentId))
    .where(eq(configBackups.orgId, user.orgId))
    .orderBy(desc(configBackups.createdAt))
    .limit(200);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Device configurations that agents backed up with config_backup. They're encrypted by the gate; agents only ever see a backup's size and hash. The newest 20 per device and file are kept."
      />
      <SettingsTabs current="/settings/backups" />
      <Section title="Config backups">
        {rows.length === 0 ? (
          <Empty>No backups yet. Agents with the Config Backups skill take one before changing a device.</Empty>
        ) : (
          <div className="px-frame overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Taken</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>SHA-256</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{timeAgo(b.createdAt)}</TableCell>
                    <TableCell className="font-mono">{b.target}</TableCell>
                    <TableCell>
                      <span className="font-mono">{b.filename}</span> <Pill>{b.source === "pihole" ? "pi-hole" : "ssh file"}</Pill>
                    </TableCell>
                    <TableCell className="text-right font-mono">{size(b.bytes)}</TableCell>
                    <TableCell className="font-mono text-xs" title={b.sha256}>
                      {b.sha256.slice(0, 12)}…
                    </TableCell>
                    <TableCell>{b.agentName ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <a href={`/api/backups/${b.id}`} className="inline-flex min-h-11 items-center border-2 px-3 text-sm hover:bg-accent" download>
                          Download
                        </a>
                        <ActionForm action={deleteBackupAction.bind(null, b.id)} submitLabel="Delete" submitVariant="outline" confirm={`Delete this backup of ${b.filename}?`} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </>
  );
}
