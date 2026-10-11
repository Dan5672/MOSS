"use server";

import { backupScheduleSchema, describeBackupSchedule, getSetting, parseBackupSchedule, setSetting, writeAudit } from "@moss/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { act, type ActionState } from "@/server/action";
import { PermissionError, requirePermission, verifyUserTotp } from "@/server/auth";
import { BACKUP_NAME, deleteMossBackup, issueDownloadTicket, startMossBackup } from "@/server/backup-service";
import { db } from "@/server/db";

/** MOSS backups hold the master key: they need both managing settings and managing secrets. */
async function requireBackupManager() {
  const user = await requirePermission("settings.manage");
  if (!user.permissions.has("secrets.manage")) throw new PermissionError("secrets.manage");
  return user;
}

export async function backUpNowAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requireBackupManager();
    const { keep } = parseBackupSchedule(await getSetting(db(), user.orgId, "backups.schedule"));
    await startMossBackup(keep);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "moss_backup.start", targetType: "moss_backup", details: {} });
    revalidatePath("/settings/backups");
    return "Backing up. It appears in the list when it's done (usually under a minute).";
  });
}

export async function saveBackupScheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireBackupManager();
    const num = (k: string) => z.coerce.number().int().parse(form.get(k) ?? 0);
    const schedule = backupScheduleSchema.parse({
      frequency: String(form.get("frequency") ?? "off"),
      hour: num("hour"),
      weekday: num("weekday"),
      keep: num("keep"),
    });
    await setSetting(db(), user.orgId, "backups.schedule", schedule);
    // The next slot from now on, not one that already passed.
    await setSetting(db(), user.orgId, "backups.last_scheduled", new Date().toISOString());
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: "backups.schedule", details: schedule });
    revalidatePath("/settings/backups");
    return `Schedule saved: ${describeBackupSchedule(schedule).toLowerCase()}, keeping ${schedule.keep || "every"} backup${schedule.keep === 1 ? "" : "s"}.`;
  });
}

export async function deleteMossBackupAction(name: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requireBackupManager();
    await deleteMossBackup(name);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "moss_backup.delete", targetType: "moss_backup", targetId: name, details: {} });
    revalidatePath("/settings/backups");
    return "Backup deleted.";
  });
}

/**
 * Checks a fresh two-factor code and the passphrase, then gives the browser a one-time ticket to fetch the
 * archive encrypted with that passphrase.
 */
export async function prepareBackupDownloadAction(name: string, form: FormData): Promise<{ ticket?: string; error?: string }> {
  try {
    const user = await requireBackupManager();
    if (!BACKUP_NAME.test(name)) return { error: "No such backup." };
    if (!user.totpEnabled) return { error: "Downloading a MOSS backup needs two-factor sign-in. Turn it on in Settings → General first." };
    const passphrase = String(form.get("passphrase") ?? "");
    if (passphrase.length < 12) return { error: "Use a passphrase of at least 12 characters." };
    if (passphrase !== String(form.get("confirm") ?? "")) return { error: "The passphrases don't match." };
    if (!(await verifyUserTotp(user.id, String(form.get("code") ?? "")))) {
      await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "moss_backup.download_denied", targetType: "moss_backup", targetId: name, details: { reason: "totp" } });
      return { error: "That code didn't match." };
    }
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "moss_backup.download", targetType: "moss_backup", targetId: name, details: { encrypted: true } });
    return { ticket: issueDownloadTicket(user.id, name, passphrase) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
}
