// Fresh database for every e2e run: migrate and truncate everything. Also starts a stand-in for the
// gate's write-only secrets API that runs the gate's own writeSecret, so secrets are really encrypted.
import { parseMasterKey } from "@moss/core";
import { createDb } from "@moss/db";
import { createTestDb } from "@moss/db/testing";
import { createServer } from "node:http";
import { E2E_DATABASE_URL, E2E_GATE_PORT, E2E_WEB_TOKEN } from "../playwright.config";

export default async function globalSetup() {
  const { close } = await createTestDb("web_e2e");
  await close();

  // The gate isn't a dependency of the web app; use its built secrets API directly.
  const { secretWriteSchema, writeSecret } = (await import("../../gate/dist/secrets-api.js")) as typeof import("../../gate/src/secrets-api");
  const db = createDb(E2E_DATABASE_URL);
  const masterKey = parseMasterKey(Buffer.from("22".repeat(32)));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const reply = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      if (req.method !== "POST" || req.url !== "/v1/secrets") return reply(404, { error: "not found" });
      if (req.headers.authorization !== `Bearer ${E2E_WEB_TOKEN}`) return reply(401, { error: "unauthorized" });
      try {
        reply(200, await writeSecret(db, masterKey, secretWriteSchema.parse(JSON.parse(body))));
      } catch (err) {
        reply(400, { error: (err as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(E2E_GATE_PORT, "127.0.0.1", resolve));
  return async () => {
    server.close();
    await db.$client.end();
  };
}
