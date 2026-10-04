// Write-only secrets API against Postgres. Run with MOSS_TEST_DATABASE_URL set.
import { bootstrapOrg, decryptSecret, generateMasterKey } from "@moss/core";
import { auditLog, secrets, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeSecret } from "./secrets-api.js";
import { buildGateServer } from "./server.js";
import { createGate } from "./service.js";

const WORKER_TOKEN = "w".repeat(40);
const WEB_TOKEN = "u".repeat(40);

describe.skipIf(!TEST_DATABASE_URL)("gate secrets API (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildGateServer>;
  let userId: string;
  const masterKey = generateMasterKey();

  const post = (token: string, payload: unknown) =>
    app.inject({ method: "POST", url: "/v1/secrets", headers: { authorization: `Bearer ${token}` }, payload: payload as object });

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_secrets"));
    ({ owner: { id: userId } } = await bootstrapOrg(db, { orgName: "x", ownerEmail: "o@x.test", ownerName: "o", ownerPassword: "a-long-test-password" }));
    const gate = createGate({ db, masterKey, toolbox: { call: async () => ({ ok: true }) } });
    app = buildGateServer(gate, { token: WORKER_TOKEN, secrets: { token: WEB_TOKEN, write: (i) => writeSecret(db, masterKey, i) } });
  });
  afterAll(() => close?.());

  it("only accepts the web token, and the web token can't reach worker routes", async () => {
    expect((await post(WORKER_TOKEN, {})).statusCode).toBe(401);
    const res = await app.inject({
      method: "POST",
      url: "/v1/tool-calls",
      headers: { authorization: `Bearer ${WEB_TOKEN}` },
      payload: { agentId: userId, tool: "ping", args: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates, then rotates, a secret without ever returning or logging its value", async () => {
    const first = await post(WEB_TOKEN, { userId, name: "anthropic-key", type: "api_token", value: "sk-ant-first-value" });
    expect(first.json()).toEqual({ id: expect.any(String), created: true });
    const { id } = first.json();

    const second = await post(WEB_TOKEN, { userId, name: "anthropic-key", type: "api_token", value: "sk-ant-second-value" });
    expect(second.json()).toEqual({ id, created: false });

    const [row] = await db.select().from(secrets).where(eq(secrets.id, id));
    expect(decryptSecret(masterKey, id, row!)).toBe("sk-ant-second-value");
    const audit = JSON.stringify(await db.select().from(auditLog));
    expect(audit).toContain("secret.rotate");
    expect(audit).not.toContain("sk-ant-");
    expect(JSON.stringify(first.json()) + JSON.stringify(second.json())).not.toContain("sk-ant-");
  });

  it("validates input and refuses unknown users", async () => {
    expect((await post(WEB_TOKEN, { userId, name: "bad name!", type: "api_token", value: "x" })).statusCode).toBe(400);
    expect((await post(WEB_TOKEN, { userId: "00000000-0000-0000-0000-000000000000", name: "k", type: "api_token", value: "x" })).json()).toEqual({
      error: "Unknown user",
    });
  });

  it("rejects configurations where the two tokens are the same", () => {
    const gate = createGate({ db, masterKey, toolbox: { call: async () => ({ ok: true }) } });
    expect(() => buildGateServer(gate, { token: WORKER_TOKEN, secrets: { token: WORKER_TOKEN, write: async () => ({ id: "", created: true }) } })).toThrow(
      /must differ/,
    );
  });
});
