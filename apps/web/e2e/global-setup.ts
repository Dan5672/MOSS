// Fresh database for every e2e run: migrate and truncate everything. Also starts a stand-in for the
// gate's write-only secrets API that runs the gate's own writeSecret, so secrets are really encrypted.
import { parseMasterKey } from "@moss/core";
import { createDb } from "@moss/db";
import { createTestDb } from "@moss/db/testing";
import { createServer } from "node:http";
import { E2E_DATABASE_URL, E2E_GATE_PORT, E2E_MASTER_KEY_HEX, E2E_WEB_TOKEN } from "../playwright.config";

interface GateBackupsApi {
  readBackup(db: ReturnType<typeof createDb>, masterKey: Buffer, id: string, userId: string): Promise<{ filename: string; contentType: string; content: Buffer } | null>;
}

interface GateSecretsApi {
  secretWriteSchema: { parse(input: unknown): unknown };
  writeSecret(db: ReturnType<typeof createDb>, masterKey: Buffer, input: unknown): Promise<{ id: string; created: boolean }>;
}

export default async function globalSetup() {
  const { close } = await createTestDb("web_e2e");
  await close();

  // The gate isn't a dependency of the web app; load its built secrets API at run time. The path is a
  // variable so `next build` (which typechecks this file) doesn't need the gate built too.
  const gateSecretsApi = "../../gate/dist/secrets-api.js";
  const { secretWriteSchema, writeSecret } = (await import(gateSecretsApi)) as GateSecretsApi;
  const gateBackupsApi = "../../gate/dist/backups.js";
  const { readBackup } = (await import(gateBackupsApi)) as GateBackupsApi;
  const db = createDb(E2E_DATABASE_URL);
  const masterKey = parseMasterKey(Buffer.from(E2E_MASTER_KEY_HEX));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const reply = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      if (req.headers.authorization !== `Bearer ${E2E_WEB_TOKEN}`) return reply(401, { error: "unauthorized" });
      const download = req.method === "GET" ? /^\/v1\/backups\/([0-9a-f-]{36})\?userId=([0-9a-f-]{36})$/.exec(req.url ?? "") : null;
      if (download) {
        const backup = await readBackup(db, masterKey, download[1]!, download[2]!);
        if (!backup) return reply(404, { error: "no such backup" });
        return res
          .writeHead(200, { "content-type": backup.contentType, "content-disposition": `attachment; filename="${backup.filename}"` })
          .end(backup.content);
      }
      if (req.method !== "POST" || req.url !== "/v1/secrets") return reply(404, { error: "not found" });
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
