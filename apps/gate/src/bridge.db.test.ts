// The chat bridge's bot tokens: only for switched-on chat apps, and Slack only with a licence and both its tokens.
import { bootstrapOrg, encryptSecret, generateMasterKey, saveLicence, saveModule, signLicence } from "@moss/core";
import { secrets, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridgeCredentials } from "./bridge.js";

const fixtures = join(__dirname, "../../../packages/core/src/fixtures/licence");
process.env.MOSS_LICENCE_EXTRA_PUBLIC_KEY = readFileSync(join(fixtures, "test.pub"), "utf8").trim();

describe.skipIf(!TEST_DATABASE_URL)("chat bridge tokens (gate)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  const masterKey = generateMasterKey();
  const store = async (name: string, value: string) => {
    const id = randomUUID();
    await db.insert(secrets).values({ id, orgId, name, type: "api_token", allowedTools: ["chat_bridge"], ...encryptSecret(masterKey, id, value) });
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_bridge"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Acme", ownerEmail: "o@acme.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
  });
  afterAll(() => close?.());

  it("hands out Slack's tokens only with a licence and both tokens", async () => {
    const credentials = createBridgeCredentials({ db, masterKey });
    await store("telegram-bot-token", "123:telegram");
    await store("slack-bot-token", "xoxb-bot");
    await saveModule(db, orgId, "telegram", { enabled: true, config: {} }, { type: "user", id: ownerId });
    await saveModule(db, orgId, "slack", { enabled: true, config: {} }, { type: "user", id: ownerId });
    expect(await credentials()).toEqual([{ orgId, platform: "telegram", token: "123:telegram" }]);

    const lic = signLicence(
      { v: 1, kid: "test", id: "l1", licensee: "Acme", plan: "business", features: ["slack"], issued: "2030-01-01T00:00:00.000Z", expires: "2099-01-01T00:00:00.000Z" },
      readFileSync(join(fixtures, "test.key"), "utf8"),
    );
    await saveLicence(db, orgId, lic, { type: "user", id: ownerId });
    // Licensed, but no app-level token yet: no Slack bot.
    expect((await credentials()).map((c) => c.platform)).toEqual(["telegram"]);
    await store("slack-app-token", "xapp-app");
    expect((await credentials()).find((c) => c.platform === "slack")).toEqual({ orgId, platform: "slack", token: "xoxb-bot", appToken: "xapp-app" });
  });
});
