"use server";

import { writeAudit } from "@moss/core";
import { configBackups } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

export async function deleteBackupAction(backupId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("secrets.manage");
    const [row] = await db()
      .delete(configBackups)
      .where(and(eq(configBackups.id, backupId), eq(configBackups.orgId, user.orgId)))
      .returning({ filename: configBackups.filename, target: configBackups.target });
    if (!row) throw new Error("Backup not found");
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "backup.delete", targetType: "config_backup", targetId: backupId, details: row });
    return `Deleted the backup of ${row.filename}.`;
  });
}
