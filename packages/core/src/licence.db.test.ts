// The org's business licence: stored, checked on use, and reminders before and after it expires.
import { notifications, settings, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signLicence, type LicencePayload } from "./licensing/licence.js";
import { getLicenceStatus, integrationLicensed, LicenceError, remindLicenceExpiry, removeLicence, saveLicence } from "./licensing/service.js";
import { bootstrapOrg } from "./store/bootstrap.js";

const fixtures = join(__dirname, "fixtures", "licence");
const pem = readFileSync(join(fixtures, "test.key"), "utf8");
process.env.MOSS_LICENCE_EXTRA_PUBLIC_KEY = readFileSync(join(fixtures, "test.pub"), "utf8").trim();

const key = (over: Partial<LicencePayload> = {}) =>
  signLicence({ v: 1, kid: "test", id: "lic-1", licensee: "Acme Ltd", plan: "business", features: ["*"], issued: "2030-01-01T00:00:00.000Z", expires: "2031-01-01T00:00:00.000Z", ...over }, pem);

describe.skipIf(!TEST_DATABASE_URL)("business licence (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  const owner = () => ({ type: "user" as const, id: ownerId });
  const aws = { key: "aws", plan: "business" as const };

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_licence"));
    const boot = await bootstrapOrg(db, { orgName: "Acme", ownerEmail: "o@acme.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    ownerId = boot.owner.id;
  });
  afterAll(async () => close?.());
  beforeEach(async () => {
    await db.delete(settings).where(eq(settings.orgId, orgId));
    await db.delete(notifications);
  });

  it("stores a genuine key and unlocks business integrations; refuses bad and expired ones", async () => {
    const at = new Date("2030-06-01T00:00:00Z");
    expect(await integrationLicensed(db, orgId, aws, at)).toBe(false);
    expect(await integrationLicensed(db, orgId, { key: "pihole", plan: "free" }, at)).toBe(true);
    await expect(saveLicence(db, orgId, "MOSS1.nope.nope", owner(), at)).rejects.toThrow(LicenceError);
    await expect(saveLicence(db, orgId, key({ expires: "2030-01-02T00:00:00.000Z" }), owner(), at)).rejects.toThrow(/expired on/);
    await saveLicence(db, orgId, key({ features: ["aws"] }), owner(), at);
    expect((await getLicenceStatus(db, orgId, at)).state).toBe("valid");
    expect(await integrationLicensed(db, orgId, aws, at)).toBe(true);
    expect(await integrationLicensed(db, orgId, { key: "m365", plan: "business" }, at)).toBe(false);
    await removeLicence(db, orgId, owner());
    expect(await integrationLicensed(db, orgId, aws, at)).toBe(false);
  });

  it("reminds the people who manage settings once at each step", async () => {
    await saveLicence(db, orgId, key(), owner(), new Date("2030-06-01T00:00:00Z"));
    expect(await remindLicenceExpiry(db, orgId, new Date("2030-11-01T00:00:00Z"))).toBeNull();
    expect(await remindLicenceExpiry(db, orgId, new Date("2030-12-05T00:00:00Z"))).toBe("30");
    expect(await remindLicenceExpiry(db, orgId, new Date("2030-12-06T00:00:00Z"))).toBeNull();
    // Missed the 7-day one: the expiry notice covers it, and nothing is sent twice.
    expect(await remindLicenceExpiry(db, orgId, new Date("2031-01-03T00:00:00Z"))).toBe("expired");
    expect(await remindLicenceExpiry(db, orgId, new Date("2031-01-04T00:00:00Z"))).toBeNull();
    expect(await integrationLicensed(db, orgId, aws, new Date("2031-01-04T00:00:00Z"))).toBe(true);
    expect(await remindLicenceExpiry(db, orgId, new Date("2031-01-20T00:00:00Z"))).toBe("stopped");
    expect(await integrationLicensed(db, orgId, aws, new Date("2031-01-20T00:00:00Z"))).toBe(false);
    const sent = await db.select().from(notifications).where(eq(notifications.userId, ownerId));
    expect(sent.map((n) => n.title)).toEqual([
      "MOSS's business licence expires in 27 days",
      "MOSS's business licence has expired",
      "MOSS's business licence has run out",
    ]);
  });
});
