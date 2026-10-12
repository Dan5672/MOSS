import { openQueue } from "@moss/agent";
import { createDb } from "@moss/db";
import { readFileSync } from "node:fs";
import { httpHomeAssistant } from "./home-assistant.js";
import { httpIntegrations } from "./integrations.js";
import { httpMonitorChecker } from "./monitor-runner.js";
import { gateProviderFactory, httpGate, startWorker } from "./worker.js";

/** Starts a MOSS backup on the backup service (it runs in the background there). */
function httpStartBackup(url: string, token: string) {
  return async (keep: number) => {
    const res = await fetch(`${url.replace(/\/+$/, "")}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keep, reason: "scheduled" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 409) throw new Error(`backup service: HTTP ${res.status}`);
  };
}

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
const llmToken = process.env.LLM_TOKEN || process.env.LLM_TOKEN_FILE ? secretFromEnv("LLM_TOKEN") : undefined;

// The job queue signs in as its own role (deploy/docker-compose.yml); development uses the one database URL.
const boss = openQueue(process.env.QUEUE_DATABASE_URL ?? databaseUrl);
boss.on("error", (err) => console.error(JSON.stringify({ msg: "queue error", error: String(err) })));
await boss.start();

const worker = await startWorker({
  db: createDb(databaseUrl),
  boss,
  gate: httpGate(gateUrl, gateToken),
  providerFor: gateProviderFactory(gateUrl, llmToken ?? gateToken),
  checkMonitor: httpMonitorChecker(gateUrl, gateToken),
  homeAssistant: httpHomeAssistant(gateUrl, gateToken),
  integrations: httpIntegrations(gateUrl, gateToken),
  // Claude subscription agents: the CLI talks to the gate's LLM proxy, which adds the subscription token.
  // The CLI gets a token that only works for the LLM proxy, never the worker's own.
  claudeCode: { baseUrlFor: (providerId) => `${gateUrl.replace(/\/+$/, "")}/v1/llm/${providerId}`, apiKey: llmToken ?? gateToken },
  libraryDir: process.env.MOSS_LIBRARY_DIR ?? "/app/library",
  startBackup: process.env.BACKUP_URL ? httpStartBackup(process.env.BACKUP_URL, secretFromEnv("BACKUP_TOKEN")) : undefined,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void worker.stop().then(() => process.exit(0)));
}
