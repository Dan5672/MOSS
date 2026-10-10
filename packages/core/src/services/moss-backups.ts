// Scheduled MOSS backups (Settings → Backups). The worker decides when one is due and asks the backup service
// to make it; the service keeps the newest N. Times are in the install's time zone (TZ in deploy/.env).
import { z } from "zod";

export const backupScheduleSchema = z.object({
  frequency: z.enum(["off", "daily", "weekly"]).default("off"),
  /** Hour of the day (0-23). */
  hour: z.number().int().min(0).max(23).default(3),
  /** Day of the week for weekly backups (0 = Sunday). */
  weekday: z.number().int().min(0).max(6).default(0),
  /** How many archives to keep (oldest go first; 0 keeps all). Applies to every MOSS backup. */
  keep: z.number().int().min(0).max(365).default(10),
});
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;

export function parseBackupSchedule(value: unknown): BackupSchedule {
  const parsed = backupScheduleSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : backupScheduleSchema.parse({});
}

/** The most recent time the schedule says a backup should have started, at or before now (null when off). */
export function lastBackupSlot(s: BackupSchedule, now = new Date()): Date | null {
  if (s.frequency === "off") return null;
  const slot = new Date(now);
  slot.setHours(s.hour, 0, 0, 0);
  if (s.frequency === "daily") {
    if (slot > now) slot.setDate(slot.getDate() - 1);
    return slot;
  }
  slot.setDate(slot.getDate() - ((slot.getDay() - s.weekday + 7) % 7));
  if (slot > now) slot.setDate(slot.getDate() - 7);
  return slot;
}

/**
 * Whether a scheduled backup is due: a slot has passed since the last scheduled one started. A missed slot
 * (MOSS was off) runs when MOSS is back. Saving a schedule counts as the last start, so turning it on
 * doesn't back up straight away.
 */
export function backupDue(s: BackupSchedule, lastStarted: Date | null, now = new Date()): boolean {
  const slot = lastBackupSlot(s, now);
  return !!slot && (!lastStarted || lastStarted < slot);
}

/** "Every day at 03:00", "Every Sunday at 03:00", or "Off". */
export function describeBackupSchedule(s: BackupSchedule): string {
  const at = `${String(s.hour).padStart(2, "0")}:00`;
  if (s.frequency === "daily") return `Every day at ${at}`;
  if (s.frequency === "weekly") return `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][s.weekday]} at ${at}`;
  return "Off";
}
