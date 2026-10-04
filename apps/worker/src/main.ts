import { createDb } from "@moss/db";
import { readFileSync } from "node:fs";
import { PgBoss } from "pg-boss";
import { httpMonitorChecker } from "./monitor-runner.js";
import { gateProviderFactory, httpGate, startWorker } from "./worker.js";

function secretFromEnv(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, "utf8").trim() : process.env[name];
  if (!value) throw new Error(`Set ${name} or ${name}_FILE`);
  return value;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");
const gateUrl = process.env.GATE_URL ?? "http://gate:7080";
const gateToken = secretFromEnv("GATE_TOKEN");

const boss = new PgBoss(databaseUrl);
boss.on("error", (err) => console.error(JSON.stringify({ msg: "queue error", error: String(err) })));
await boss.start();

const worker = await startWorker({
  db: createDb(databaseUrl),
  boss,
  gate: httpGate(gateUrl, gateToken),
  providerFor: gateProviderFactory(gateUrl, gateToken),
  checkMonitor: httpMonitorChecker(gateUrl, gateToken),
  libraryDir: process.env.MOSS_LIBRARY_DIR ?? "/app/library",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void worker.stop().then(() => process.exit(0)));
}
