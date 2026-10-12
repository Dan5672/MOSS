// Job queue names and helpers shared by the worker (consumer) and the web app (producer).
import { PgBoss } from "pg-boss";
import type { RunInput } from "./runtime.js";

export const RUN_QUEUE = "agent-run";
export const SCHEDULE_QUEUE = "agent-schedule";

/**
 * Opens the job queue. Its schema is made by the migrate step (packages/db/src/migrate.ts), never by pg-boss: the
 * queue's database role may not create schemas (packages/db/src/roles.ts), and Postgres refuses even
 * CREATE SCHEMA IF NOT EXISTS without that right.
 */
export function openQueue(url: string): PgBoss {
  return new PgBoss({ connectionString: url, createSchema: false });
}

export async function ensureQueues(boss: PgBoss) {
  // "singleton" policy + singletonKey = agent id: at most one active run per agent; others wait.
  await boss.createQueue(RUN_QUEUE, { policy: "singleton" });
  await boss.createQueue(SCHEDULE_QUEUE);
}

export async function enqueueRun(boss: PgBoss, input: RunInput): Promise<string | null> {
  return boss.send(RUN_QUEUE, input, { singletonKey: input.agentId, retryLimit: 0, expireInSeconds: 60 * 60 });
}
