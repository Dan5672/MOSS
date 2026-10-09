// The wiki against Postgres: slugs, the page tree, revisions and asset links.
import { assets, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNote, deleteNote, findPage, getNote, pageRevisions, pagesForAsset, slugify, updateNote } from "./services/knowledge.js";
import { bootstrapOrg } from "./store/bootstrap.js";

describe("slugify", () => {
  it("makes readable, safe page addresses", () => {
    expect(slugify("Living room AP (U6-Pro)")).toBe("living-room-ap-u6-pro");
    expect(slugify("Café router")).toBe("cafe-router");
    expect(slugify("!!!")).toBe("page");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("wiki (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let owner: { type: "user"; id: string };

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_wiki"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    owner = { type: "user", id: boot.owner.id };
  });
  afterAll(() => close?.());

  it("unique slugs, found by slug or title, revisions on edit, and the slug stays put", async () => {
    const a = await createNote(db, orgId, { title: "Network", body: "One LAN." }, owner);
    const b = await createNote(db, orgId, { title: "Network", body: "A second page with the same title." }, owner);
    expect([a.slug, b.slug]).toEqual(["network", "network-2"]);
    expect((await findPage(db, orgId, "NETWORK"))!.id).toBe(a.id);
    expect((await findPage(db, orgId, "network-2"))!.id).toBe(b.id);

    await updateNote(db, orgId, a.id, { title: "Network layout", body: "One LAN and an IoT VLAN." }, { type: "agent", id: null as never });
    const now = (await getNote(db, orgId, a.id))!;
    expect(now).toMatchObject({ title: "Network layout", slug: "network" });
    expect((await pageRevisions(db, a.id)).map((r) => [r.title, r.body])).toEqual([["Network", "One LAN."]]);
  });

  it("pages sit in a tree without loops; deleting one moves its children up; pages link to assets", async () => {
    const devices = await createNote(db, orgId, { title: "Devices", body: "Everything on the network." }, owner);
    const [nas] = await db.insert(assets).values({ orgId, name: "nas", source: "user" }).returning();
    const nasPage = await createNote(db, orgId, { title: "NAS", body: "Synology.", parentId: devices.id, assetId: nas!.id }, owner);
    const disks = await createNote(db, orgId, { title: "NAS disks", body: "Four drives.", parentId: nasPage.id }, owner);
    await expect(updateNote(db, orgId, devices.id, { title: "Devices", body: "x", parentId: disks.id }, owner)).rejects.toThrow(/under itself/);
    expect((await pagesForAsset(db, orgId, nas!.id)).map((p) => p.title)).toEqual(["NAS"]);
    await deleteNote(db, orgId, nasPage.id, owner);
    expect((await getNote(db, orgId, disks.id))!.parentId).toBe(devices.id);
  });
});
