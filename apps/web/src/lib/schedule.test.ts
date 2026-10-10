import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cronProblem, describeCron, fromCron, repeatFromForm, toCron, type Repeat } from "./schedule";

const form = (fields: Record<string, string>) => (name: string) => fields[name];

describe("schedules", () => {
  it("round-trips every simple repeat through cron", () => {
    const repeats: Repeat[] = [
      { kind: "hourly", minute: 0 },
      { kind: "hourly", minute: 15 },
      { kind: "every_hours", hours: 4, minute: 30 },
      { kind: "daily", hour: 2, minute: 30 },
      { kind: "weekdays", hour: 8, minute: 0 },
      { kind: "weekly", days: [0], hour: 3, minute: 0 },
      { kind: "weekly", days: [1, 3, 5], hour: 9, minute: 5 },
      { kind: "monthly", day: 1, hour: 6, minute: 0 },
    ];
    for (const r of repeats) {
      expect(cronProblem(toCron(r)), toCron(r)).toBeNull();
      expect(fromCron(toCron(r))).toEqual(r);
    }
  });

  it("describes the built-in template schedules in words", () => {
    expect(describeCron("0 * * * *")).toBe("Every hour, on the hour");
    expect(describeCron("30 2 * * *")).toBe("Every day at 02:30");
    expect(describeCron("0 3 * * 0")).toBe("Sundays at 03:00");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours, at 00 past");
    expect(describeCron("0 9 * * 1,3,5")).toBe("Mondays, Wednesdays and Fridays at 09:00");
    expect(describeCron("0 8 * * 1-5")).toBe("Weekdays at 08:00");
    expect(describeCron("0 6 1 * *")).toBe("Monthly on the 1st at 06:00");
    // Day 7 is Sunday too.
    expect(fromCron("0 3 * * 7")).toEqual({ kind: "weekly", days: [0], hour: 3, minute: 0 });

    // Every schedule shipped in the library reads as words, not "custom".
    const dir = join(__dirname, "../../../../library/templates");
    for (const file of readdirSync(dir)) {
      for (const [, cron] of readFileSync(join(dir, file), "utf8").matchAll(/cron:\s*"([^"]+)"/g)) {
        expect(fromCron(cron!).kind, `${file}: ${cron}`).not.toBe("custom");
      }
    }
  });

  it("keeps anything else as custom cron", () => {
    expect(fromCron("*/15 9-17 * * 1-5")).toEqual({ kind: "custom", cron: "*/15 9-17 * * 1-5" });
    expect(fromCron("0 6 31 * *").kind).toBe("custom");
    expect(describeCron("*/15 9-17 * * 1-5")).toBe("Custom schedule (*/15 9-17 * * 1-5)");
  });

  it("rejects malformed, out-of-range and every-minute cron", () => {
    expect(cronProblem("0 * * *")).toMatch(/five fields/);
    expect(cronProblem("0 25 * * *")).toMatch(/out of range/);
    expect(cronProblem("0 5-2 * * *")).toMatch(/backwards/);
    expect(cronProblem("0 * * * mon")).toMatch(/isn't a valid/);
    expect(cronProblem("* * * * *")).toMatch(/every 5 minutes/);
    expect(cronProblem("*/2 * * * *")).toMatch(/every 5 minutes/);
    expect(cronProblem("*/5 * * * *")).toBeNull();
  });

  it("builds a repeat from form fields, with readable errors", () => {
    expect(repeatFromForm(form({ repeat: "hourly", minute: "0" }))).toEqual({ kind: "hourly", minute: 0 });
    expect(repeatFromForm(form({ repeat: "every_hours", hours: "4", minute: "0" }))).toEqual({ kind: "every_hours", hours: 4, minute: 0 });
    expect(repeatFromForm(form({ repeat: "weekly", days: "1,5", time: "07:45" }))).toEqual({ kind: "weekly", days: [1, 5], hour: 7, minute: 45 });
    expect(() => repeatFromForm(form({ repeat: "daily", time: "" }))).toThrow(/Choose a time/);
    expect(() => repeatFromForm(form({ repeat: "weekly", days: "", time: "07:00" }))).toThrow(/at least one day/);
    expect(() => repeatFromForm(form({ repeat: "every_hours", hours: "5", minute: "0" }))).toThrow(/how many hours/);
    expect(() => repeatFromForm(form({ repeat: "monthly", day: "30", time: "06:00" }))).toThrow(/1–28/);
    expect(() => repeatFromForm(form({ repeat: "custom", cron: "* * * * *" }))).toThrow(/every 5 minutes/);
  });
});
