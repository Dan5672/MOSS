// Operator CLI (until the web UI lands):
//   moss-cli run <agentId> "<task>"   queue a manual run
//   moss-cli agents                   list agents
//   moss-cli runs [agentId]           show recent runs
import { agentRuns, agents, createDb } from "@moss/db";
import { desc, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { enqueueRun, RUN_QUEUE } from "./worker.js";

const [command, ...args] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");
const db = createDb(databaseUrl);

switch (command) {
  case "run": {
    const [agentId, task] = args;
    if (!agentId || !task) throw new Error('Usage: moss-cli run <agentId> "<task>"');
    const boss = new PgBoss(databaseUrl);
    await boss.start();
    await boss.createQueue(RUN_QUEUE, { policy: "singleton" });
    const jobId = await enqueueRun(boss, { agentId, task, trigger: "manual" });
    console.log(jobId ? `Queued run ${jobId}` : "Not queued (a run for this agent may already be waiting)");
    await boss.stop({ graceful: false });
    break;
  }
  case "agents": {
    for (const a of await db.select().from(agents).orderBy(agents.hiredAt)) {
      console.log(`${a.id}  ${a.status.padEnd(7)}  ${a.name} (${a.title})`);
    }
    break;
  }
  case "runs": {
    const rows = await db
      .select()
      .from(agentRuns)
      .where(args[0] ? eq(agentRuns.agentId, args[0]) : undefined)
      .orderBy(desc(agentRuns.startedAt))
      .limit(20);
    for (const r of rows) console.log(`${r.startedAt.toISOString()}  ${r.status.padEnd(9)}  ${r.trigger.padEnd(8)}  ${r.summary ?? ""}`);
    break;
  }
  default:
    console.log('Commands: run <agentId> "<task>" | agents | runs [agentId]');
}
process.exit(0);
