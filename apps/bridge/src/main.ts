// MOSS's chat bridge: Telegram and Discord bots. It reads and writes MOSS's database like the worker, gets the
// bot tokens from the gate (which decrypts them only while their integration is on), and is the only service
// that talks to Telegram and Discord.
import { createDb } from "@moss/db";
import { readFileSync } from "node:fs";
import { PgBoss } from "pg-boss";
import { createBridge, type Credential } from "./bridge.js";

function secretFromEnv(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, "utf8").trim() : process.env[name];
  if (!value) throw new Error(`Set ${name} or ${name}_FILE`);
  return value;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");
const gateUrl = (process.env.GATE_URL ?? "http://gate:7080").replace(/\/+$/, "");
const bridgeToken = secretFromEnv("BRIDGE_TOKEN");
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));

const boss = new PgBoss(databaseUrl);
boss.on("error", (err) => log("queue error", { error: String(err) }));
await boss.start();

const bridge = createBridge({
  db: createDb(databaseUrl),
  boss,
  log,
  credentials: async () => {
    const res = await fetch(`${gateUrl}/v1/bridge/credentials`, { headers: { authorization: `Bearer ${bridgeToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`gate: HTTP ${res.status}`);
    return ((await res.json()) as { bots: Credential[] }).bots;
  },
});

const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      log(`${name} failed`, { error: (err as Error).message });
    } finally {
      busy = false;
    }
  };
  void run();
  return setInterval(run, ms);
};

const timers = [every(30_000, "bot sync", bridge.sync), every(3_000, "chat send", bridge.flush), every(60 * 60_000, "chat prune", bridge.prune)];
log("chat bridge running");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const t of timers) clearInterval(t);
    bridge.stop();
    void boss.stop({ graceful: true }).then(() => process.exit(0));
  });
}
