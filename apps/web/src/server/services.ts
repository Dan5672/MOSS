import "server-only";
import { ensureQueues, enqueueRun, loadLibrary, type Library, type RunInput } from "@moss/agent";
import { PgBoss } from "pg-boss";
import { config } from "./config";

const g = globalThis as { __mossBoss?: Promise<PgBoss>; __mossLibrary?: Promise<Library> };

/** Queue producer (the worker consumes). */
async function boss(): Promise<PgBoss> {
  g.__mossBoss ??= (async () => {
    const b = new PgBoss(process.env.DATABASE_URL!);
    b.on("error", (err) => console.error("queue error", err));
    await b.start();
    await ensureQueues(b);
    return b;
  })();
  return g.__mossBoss;
}

export async function queueRun(input: RunInput) {
  return enqueueRun(await boss(), input);
}

export function library(): Promise<Library> {
  g.__mossLibrary ??= loadLibrary(config.libraryDir());
  return g.__mossLibrary;
}

/** Stores a secret through the gate (the only service that can encrypt). Returns its id. */
export async function storeSecret(input: {
  userId: string;
  name: string;
  type: "password" | "ssh_key" | "api_token" | "snmp_community" | "other";
  value: string;
  username?: string;
  description?: string;
  allowedHosts?: string[];
  allowedTools?: string[];
}): Promise<string> {
  const res = await fetch(`${config.gateUrl()}/v1/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.webToken()}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `The gate refused to store the secret (HTTP ${res.status})`);
  return body.id;
}
