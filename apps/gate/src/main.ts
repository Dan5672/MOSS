import { parseMasterKey } from "@moss/core";
import { createDb } from "@moss/db";
import { readFileSync } from "node:fs";
import { createLlmProxy } from "./llm-proxy.js";
import { readBackup } from "./backups.js";
import { writeSecret } from "./secrets-api.js";
import { buildGateServer } from "./server.js";
import { createGate } from "./service.js";
import { HttpToolboxClient } from "./toolbox-client.js";

function secretFromEnv(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, "utf8").trim() : process.env[name];
  if (!value) throw new Error(`Set ${name} or ${name}_FILE`);
  return value;
}

const masterKeyFile = process.env.MOSS_MASTER_KEY_FILE;
if (!masterKeyFile) throw new Error("Set MOSS_MASTER_KEY_FILE");

const db = createDb();
const masterKey = parseMasterKey(readFileSync(masterKeyFile));
const gate = createGate({
  db,
  masterKey,
  toolbox: new HttpToolboxClient(process.env.TOOLBOX_URL ?? "http://toolbox:7070", secretFromEnv("TOOLBOX_TOKEN")),
});

const app = buildGateServer(gate, {
  token: secretFromEnv("GATE_TOKEN"),
  llmProxy: createLlmProxy({ db, masterKey }),
  secrets: {
    token: secretFromEnv("WEB_TOKEN"),
    write: (input) => writeSecret(db, masterKey, input),
    readBackup: (backupId, userId) => readBackup(db, masterKey, backupId, userId),
  },
  logger: true,
});
await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 7080) });
