import { describe, expect, it } from "vitest";
import { buildGateServer } from "./server.js";
import type { Gate } from "./service.js";

const WORKER = "w".repeat(40);
const WEB = "x".repeat(40);
const BRIDGE = "b".repeat(40);

describe("gate route tokens", () => {
  const server = buildGateServer({} as Gate, {
    token: WORKER,
    secrets: { token: WEB, write: async () => ({ id: "s", created: true }) },
    bridge: { token: BRIDGE, credentials: async () => [{ orgId: "o", platform: "telegram", token: "bot-token" }] },
  });
  const get = (url: string, token: string) => server.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  it("checks the route the router matched, so an encoded path can't borrow the worker's token", async () => {
    expect((await get("/v1/bridge/credentials", BRIDGE)).statusCode).toBe(200);
    for (const url of ["/v1/bridge/credentials", "/v1/%62ridge/credentials", "/v1/bridge/%63redentials"]) {
      expect((await get(url, WORKER)).statusCode).toBe(401);
    }
    const write = await server.inject({ method: "POST", url: "/v1/%73ecrets", headers: { authorization: `Bearer ${WORKER}` }, payload: {} });
    expect(write.statusCode).toBe(401);
  });
});
