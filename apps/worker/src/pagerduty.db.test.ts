// PagerDuty from the worker: pages for incidents that should page (licensed and switched on), notes when paging
// failed, and notes who acknowledged or resolved each page.
import { bootstrapOrg, createIncident, notePagerdutyChanges, saveLicence, saveModule, signLicence, updateModuleState } from "@moss/core";
import { incidentComments, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { asc, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pagerdutyIncident, type IntegrationCaller } from "./integrations.js";

const fixtures = join(__dirname, "../../../packages/core/src/fixtures/licence");
process.env.MOSS_LICENCE_EXTRA_PUBLIC_KEY = readFileSync(join(fixtures, "test.pub"), "utf8").trim();

describe.skipIf(!TEST_DATABASE_URL)("PagerDuty (worker)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  const calls: { op: string; args?: Record<string, unknown> }[] = [];
  let reply: { ok: true; result: unknown } | { ok: false; error: string } = { ok: true, result: { status: "success" } };
  const call: IntegrationCaller = async (_org, _key, op, args) => (calls.push({ op, args }), reply);
  const owner = () => ({ type: "user" as const, id: ownerId });
  const comments = async (incidentId: string) => (await db.select().from(incidentComments).where(eq(incidentComments.incidentId, incidentId)).orderBy(asc(incidentComments.createdAt))).map((c) => c.body);

  beforeAll(async () => {
    ({ db, close } = await createTestDb("worker_pagerduty"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Acme", ownerEmail: "o@acme.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    await saveModule(db, orgId, "pagerduty", { enabled: true, config: { options: { pageUpTo: 2 } } }, owner());
  });
  afterAll(() => close?.());

  it("pages only with a licence, and only for priorities that page", async () => {
    const p1 = await createIncident(db, orgId, { type: "break_fix", title: "NAS web is down", priority: "P1" }, owner());
    await pagerdutyIncident(db, call, p1.id, "trigger");
    expect(calls).toEqual([]);

    const lic = signLicence(
      { v: 1, kid: "test", id: "l1", licensee: "Acme", plan: "business", features: ["pagerduty"], issued: "2030-01-01T00:00:00.000Z", expires: "2099-01-01T00:00:00.000Z" },
      readFileSync(join(fixtures, "test.key"), "utf8"),
    );
    await saveLicence(db, orgId, lic, owner());
    await pagerdutyIncident(db, call, p1.id, "trigger");
    expect(calls).toEqual([{ op: "event", args: { action: "trigger", dedupKey: p1.id, summary: `INC-${String(p1.number).padStart(4, "0")} NAS web is down`, severity: "critical", source: "MOSS" } }]);
    expect(await comments(p1.id)).toEqual(["Paged the on-call person in PagerDuty."]);

    const p3 = await createIncident(db, orgId, { type: "break_fix", title: "Printer low on toner", priority: "P3" }, owner());
    await pagerdutyIncident(db, call, p3.id, "trigger");
    expect(calls).toHaveLength(1);

    await pagerdutyIncident(db, call, p1.id, "resolve");
    expect(calls.at(-1)).toMatchObject({ op: "event", args: { action: "resolve", dedupKey: p1.id } });

    // Paging failed: the incident says so, so nobody assumes the on-call person knows.
    reply = { ok: false, error: "PagerDuty refused the event: Invalid routing key" };
    const p2 = await createIncident(db, orgId, { type: "security", title: "Suspicious sign-in", priority: "P2" }, owner());
    await pagerdutyIncident(db, call, p2.id, "trigger");
    expect(await comments(p2.id)).toEqual(["Couldn't page PagerDuty: PagerDuty refused the event: Invalid routing key"]);

    // Who acknowledged and resolved, once each.
    await updateModuleState(db, orgId, "pagerduty", {
      pagerduty: { incidents: [{ key: p1.id, status: "acknowledged", by: "Dana Owner" }, { key: p2.id, status: "triggered" }, { key: "not-ours", status: "resolved" }] },
    });
    expect(await notePagerdutyChanges(db, orgId)).toBe(1);
    expect(await notePagerdutyChanges(db, orgId)).toBe(0);
    await updateModuleState(db, orgId, "pagerduty", { pagerduty: { incidents: [{ key: p1.id, status: "resolved", by: "Dana Owner" }] } });
    expect(await notePagerdutyChanges(db, orgId)).toBe(1);
    expect((await comments(p1.id)).slice(1)).toEqual(["Acknowledged in PagerDuty by Dana Owner.", "Resolved in PagerDuty by Dana Owner."]);
  });
});
