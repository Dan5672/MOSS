// When scheduled MOSS backups are due.
import { describe, expect, it } from "vitest";
import { backupDue, describeBackupSchedule, lastBackupSlot, parseBackupSchedule } from "./services/moss-backups.js";

const at = (s: string) => new Date(s); // local time (no Z)

describe("MOSS backup schedule", () => {
  it("finds the last daily and weekly slot", () => {
    const daily = parseBackupSchedule({ frequency: "daily", hour: 3 });
    expect(lastBackupSlot(daily, at("2030-01-10T02:59:00"))).toEqual(at("2030-01-09T03:00:00"));
    expect(lastBackupSlot(daily, at("2030-01-10T03:00:00"))).toEqual(at("2030-01-10T03:00:00"));
    // 2030-01-10 is a Thursday; weekly on Tuesdays at 22:00.
    const weekly = parseBackupSchedule({ frequency: "weekly", weekday: 2, hour: 22 });
    expect(lastBackupSlot(weekly, at("2030-01-10T12:00:00"))).toEqual(at("2030-01-08T22:00:00"));
    expect(lastBackupSlot(weekly, at("2030-01-08T21:00:00"))).toEqual(at("2030-01-01T22:00:00"));
    expect(lastBackupSlot(parseBackupSchedule({}), at("2030-01-10T12:00:00"))).toBeNull();
  });

  it("is due once per slot, including a missed one", () => {
    const daily = parseBackupSchedule({ frequency: "daily", hour: 3 });
    expect(backupDue(daily, at("2030-01-10T01:00:00"), at("2030-01-10T02:00:00"))).toBe(false); // saved after yesterday's slot
    expect(backupDue(daily, at("2030-01-10T01:00:00"), at("2030-01-10T03:00:30"))).toBe(true);
    expect(backupDue(daily, at("2030-01-10T03:00:30"), at("2030-01-10T09:00:00"))).toBe(false);
    expect(backupDue(daily, at("2030-01-10T03:00:30"), at("2030-01-12T08:00:00"))).toBe(true); // MOSS was off
    expect(backupDue(parseBackupSchedule({ frequency: "off" }), null, at("2030-01-12T08:00:00"))).toBe(false);
  });

  it("describes itself and falls back to off", () => {
    expect(describeBackupSchedule(parseBackupSchedule({ frequency: "weekly", weekday: 0, hour: 3 }))).toBe("Every Sunday at 03:00");
    expect(describeBackupSchedule(parseBackupSchedule({ frequency: "daily", hour: 23 }))).toBe("Every day at 23:00");
    expect(parseBackupSchedule({ frequency: "hourly" })).toEqual({ frequency: "off", hour: 3, weekday: 0, keep: 10 });
  });
});
