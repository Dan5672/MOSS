import { describe, expect, it } from "vitest";
import { cronOccurrences } from "./cron";

const at = (s: string) => new Date(s);
const hm = (d: Date) => `${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("cronOccurrences", () => {
  it("daily at a time", () => {
    expect(cronOccurrences("30 7 * * *", at("2026-03-02T00:00"), at("2026-03-05T00:00")).map(hm)).toEqual(["2 07:30", "3 07:30", "4 07:30"]);
  });
  it("every 6 hours, and only inside the window", () => {
    expect(cronOccurrences("0 */6 * * *", at("2026-03-02T05:00"), at("2026-03-02T23:00")).map(hm)).toEqual(["2 06:00", "2 12:00", "2 18:00"]);
  });
  it("weekdays and lists", () => {
    // 2026-03-02 is a Monday.
    expect(cronOccurrences("0 9 * * 1,3,5", at("2026-03-02T00:00"), at("2026-03-09T00:00")).map(hm)).toEqual(["2 09:00", "4 09:00", "6 09:00"]);
    expect(cronOccurrences("15 22 * * 1-5", at("2026-03-07T00:00"), at("2026-03-10T00:00")).map(hm)).toEqual(["9 22:15"]);
  });
  it("a day of the month, a limit, and nonsense", () => {
    expect(cronOccurrences("0 3 1 * *", at("2026-01-15T00:00"), at("2026-04-15T00:00")).map((d) => d.getMonth() + 1)).toEqual([2, 3, 4]);
    expect(cronOccurrences("* * * * *", at("2026-03-02T00:00"), at("2026-03-03T00:00"), 5)).toHaveLength(5);
    expect(cronOccurrences("bad", at("2026-03-02T00:00"), at("2026-03-03T00:00"))).toEqual([]);
  });
  it("in a given time zone, across a DST change", () => {
    const utc = (d: Date) => d.toISOString().slice(0, 16);
    // 07:30 in New York is 12:30 UTC in winter and 11:30 UTC after clocks go forward (8 March 2026).
    expect(cronOccurrences("30 7 * * *", new Date("2026-03-07T00:00Z"), new Date("2026-03-10T00:00Z"), 10, "America/New_York").map(utc)).toEqual([
      "2026-03-07T12:30",
      "2026-03-08T11:30",
      "2026-03-09T11:30",
    ]);
    // Monday 09:00 in Sydney is still Sunday in UTC.
    expect(cronOccurrences("0 9 * * 1", new Date("2026-03-01T00:00Z"), new Date("2026-03-03T00:00Z"), 10, "Australia/Sydney").map(utc)).toEqual(["2026-03-01T22:00"]);
  });
});
