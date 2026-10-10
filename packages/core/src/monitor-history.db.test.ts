// Monitor history: rollups, the series graphs read, and pruning by age.
import { monitorResults, monitorRollups, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monitorSeries, monitorUptime, pruneMonitorRollups, resolutionFor, rollUpMonitorResults } from "./services/monitor-history.js";
import { createMonitor } from "./services/monitors.js";
import { bootstrapOrg } from "./store/bootstrap.js";

const T0 = new Date("2030-01-01T00:00:00Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe("resolution for a range", () => {
  it("uses raw results for a day, 5-minute buckets for a month, hourly beyond", () => {
    expect(resolutionFor(at(0), at(24 * 60))).toBe("raw");
    expect(resolutionFor(at(0), at(7 * 24 * 60))).toBe("5m");
    expect(resolutionFor(at(0), at(90 * 24 * 60))).toBe("1h");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("monitor history (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let monitorId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_monitor_history"));
    orgId = (await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" })).org.id;
    monitorId = (await createMonitor(db, orgId, { name: "Uplink", kind: "ping", target: "192.168.1.1" }, { type: "system", id: null })).id;
    // Two hours of checks every minute: latency rises 1 ms a minute, inBps is the minute times 1000, one failure
    // every 10 minutes.
    const rows = Array.from({ length: 120 }, (_, i) => ({
      monitorId,
      at: at(i),
      ok: i % 10 !== 9,
      degraded: false,
      latencyMs: 10 + i,
      message: "",
      value: i * 1000,
      values: { inBps: i * 1000, label: "not a number" as unknown as number },
    }));
    await db.insert(monitorResults).values(rows);
  });
  afterAll(() => close?.());

  it("rolls finished buckets up, then hours, and can run again safely", async () => {
    await rollUpMonitorResults(db, at(121));
    const five = await db.select().from(monitorRollups).where(eq(monitorRollups.resolution, "5m"));
    expect(five).toHaveLength(24); // 00:00-01:55; the bucket at 02:00 isn't finished
    const first = five.find((r) => r.bucket.getTime() === T0)!;
    expect(first).toMatchObject({ checks: 5, ok: 5, degraded: 0, latencyMin: 10, latencyAvg: 12, latencyMax: 14 });
    expect(first.metrics).toEqual({ inBps: { min: 0, avg: 2000, max: 4000 }, value: { min: 0, avg: 2000, max: 4000 } });
    const hours = await db.select().from(monitorRollups).where(eq(monitorRollups.resolution, "1h")).orderBy(asc(monitorRollups.bucket));
    expect(hours.map((h) => [h.bucket.toISOString(), h.checks, h.ok])).toEqual([
      ["2030-01-01T00:00:00.000Z", 60, 54],
      ["2030-01-01T01:00:00.000Z", 60, 54],
    ]);
    expect(hours[0]!.latencyAvg).toBeCloseTo(39.5);
    expect(hours[0]!.metrics.inBps).toEqual({ min: 0, avg: 29_500, max: 59_000 });

    await rollUpMonitorResults(db, at(125)); // again, a bit later: same rows, nothing doubled
    expect(await db.select().from(monitorRollups).where(eq(monitorRollups.resolution, "5m"))).toHaveLength(24);
  });

  it("answers series from raw results or rollups, only for the org's monitors", async () => {
    const raw = await monitorSeries(db, orgId, [monitorId], "inBps", at(0), at(3));
    expect(raw).toEqual({ resolution: "raw", series: { [monitorId]: [0, 1000, 2000].map((v, i) => ({ t: at(i).getTime(), avg: v, min: v, max: v })) } });
    const rolled = await monitorSeries(db, orgId, [monitorId], "latency", at(0), at(120), "5m");
    expect(rolled.series[monitorId]).toHaveLength(24);
    expect(rolled.series[monitorId]![0]).toEqual({ t: T0, avg: 12, min: 10, max: 14 });
    const up = await monitorUptime(db, orgId, [monitorId], at(0), at(120));
    expect(up[monitorId]).toBeCloseTo(0.9);
    expect(await monitorSeries(db, "00000000-0000-0000-0000-000000000000", [monitorId], "latency", at(0), at(120))).toEqual({ resolution: "raw", series: {} });
  });

  it("drops rollups older than they're kept", async () => {
    expect(await pruneMonitorRollups(db, at(89 * 24 * 60))).toBe(0);
    expect(await pruneMonitorRollups(db, at(91 * 24 * 60))).toBe(24); // the 5-minute ones go after 90 days
    expect(await db.select().from(monitorRollups)).toHaveLength(2); // hourly ones stay for two years
  });
});
