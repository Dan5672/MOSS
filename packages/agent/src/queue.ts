// Job queue names and helpers shared by the worker (consumer) and the web app (producer).
import type { PgBoss } from "pg-boss";
import type { RunInput } from "./runtime.js";

export const RUN_QUEUE = "agent-run";
export const SCHEDULE_QUEUE = "agent-schedule";

export async function ensureQueues(boss: PgBoss) {
  // "singleton" policy + singletonKey = agent id: at most one active run per agent; others wait.
  await boss.createQueue(RUN_QUEUE, { policy: "singleton" });
  await boss.createQueue(SCHEDULE_QUEUE);
}

export async function enqueueRun(boss: PgBoss, input: RunInput): Promise<string | null> {
  return boss.send(RUN_QUEUE, input, { singletonKey: input.agentId, retryLimit: 0, expireInSeconds: 60 * 60 });
}
