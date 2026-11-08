// Device logs against Postgres: the network allowlist, linking to the inventory, search and pruning.
import { assets, logEntries, networks, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLogBatch } from "./monitoring/syslog.js";
import { forgetRefusedSender, ingestLogs, pruneLogs, searchLogs, syslogSource, syslogStatus } from "./services/logs.js";
import { authenticateMonitorSource, createMonitorSource } from "./services/monitors.js";
import { bootstrapOrg } from "./store/bootstrap.js";
import { setSetting } from "./store/settings-store.js";

describe.skipIf(!TEST_DATABASE_URL)("device logs (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let assetId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_logs"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    await db.insert(networks).values([
      { orgId, cidr: "192.168.1.0/24", status: "allowed", source: "user" },
      { orgId, cidr: "192.168.1.128/25", status: "off_limits", source: "user" },
    ]);
    [{ id: assetId }] = await db.insert(assets).values({ orgId, name: "fw01", source: "user", primaryIp: "192.168.1.1" }).returning();
  });
  afterAll(async () => close?.());

  it("stores lines from allowed senders only, linking TCP ones to the device at the sender's address", async () => {
    const { source, token } = await createMonitorSource(db, orgId, { name: "Syslog", kind: "syslog" }, { type: "system", id: null });
    const authed = await authenticateMonitorSource(db, source.id, token);
    const batch = parseLogBatch(
      JSON.stringify([
        { ip: "192.168.1.1", transport: "tcp", app: "charon", severity: "err", message: "IKE SA down: 100% loss" },
        { ip: "192.168.1.1", transport: "udp", severity: "info", message: "maybe spoofed" },
        { ip: "192.168.1.5", severity: "info", message: "link up" },
        { ip: "192.168.1.200", message: "from an off-limits network" },
        { ip: "10.0.0.5", message: "from outside every network" },
      ]),
    );
    if (!batch.ok) throw new Error(batch.error);
    expect(await ingestLogs(db, authed!, batch.lines)).toEqual({ stored: 3, refused: ["192.168.1.200", "10.0.0.5"] });
    // The Logs page lists refused senders to accept; accepting one takes it off the list.
    expect((await syslogStatus(db, orgId)).refused.map((r) => r.ip)).toEqual(["192.168.1.200", "10.0.0.5"]);
    await forgetRefusedSender(db, orgId, "10.0.0.5");
    expect((await syslogStatus(db, orgId)).refused.map((r) => r.ip)).toEqual(["192.168.1.200"]);
    // The collector's lines go to the org's first syslog source.
    expect((await syslogSource(db, orgId)).id).toBe(source.id);

    const all = await searchLogs(db, orgId);
    expect(all.map((l) => [l.message, l.assetName])).toEqual(
      expect.arrayContaining([
        ["IKE SA down: 100% loss", "fw01"],
        ["maybe spoofed", null],
        ["link up", null],
      ]),
    );
    expect((await searchLogs(db, orgId, { maxSeverity: 3 })).map((l) => l.message)).toEqual(["IKE SA down: 100% loss"]);
    expect((await searchLogs(db, orgId, { assetId })).length).toBe(1);
    expect((await searchLogs(db, orgId, { ip: "192.168.1.5" })).length).toBe(1);

    // logs.allowed_senders admits a sender without making it an allowed network; off-limits still wins.
    await setSetting(db, orgId, "logs.allowed_senders", ["10.0.0.0/24", "192.168.1.200"]);
    expect(await ingestLogs(db, authed!, batch.lines.slice(3))).toEqual({ stored: 1, refused: ["192.168.1.200"] });
    await setSetting(db, orgId, "logs.allowed_senders", []);
    // LIKE wildcards in the search are literal.
    expect((await searchLogs(db, orgId, { text: "100%" })).length).toBe(1);
    expect((await searchLogs(db, orgId, { text: "%" })).length).toBe(1);
    expect((await searchLogs(db, orgId, { text: "charon ike" })).length).toBe(1);
  });

  it("prunes lines older than the retention", async () => {
    const [row] = await db.select().from(logEntries).limit(1);
    await db.insert(logEntries).values({ orgId, sourceId: row!.sourceId, sourceIp: "192.168.1.1", message: "old", receivedAt: new Date(Date.now() - 8 * 86_400_000) });
    expect(await pruneLogs(db, orgId, 7)).toBe(1);
    expect((await searchLogs(db, orgId, { text: "old", sinceHours: 24 * 30 })).length).toBe(0);
  });

  it("keeps at most maxRows lines, newest first", async () => {
    const [row] = await db.select().from(logEntries).limit(1);
    const count = async () => (await db.select().from(logEntries)).length;
    const before = await count();
    await db.insert(logEntries).values({ orgId, sourceId: row!.sourceId, sourceIp: "192.168.1.1", message: "older", receivedAt: new Date(Date.now() - 3_600_000) });
    expect(await pruneLogs(db, orgId, 7, before)).toBe(1);
    expect(await count()).toBe(before);
  });
});
