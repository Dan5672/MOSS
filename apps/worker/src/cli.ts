// Operator CLI (until the web UI lands):
//   moss-cli run <agentId> "<task>"                  queue a manual run
//   moss-cli agents                                  list agents
//   moss-cli runs [agentId]                          show recent runs
//   moss-cli incidents                               list open incidents
//   moss-cli changes                                 list recent change requests
// Approving and rejecting are done by people in MOSS: the worker's database role can't.
import { changeRef, incidentRef, listChanges, listIncidents } from "@moss/core";
import { agentRuns, agents, createDb, users } from "@moss/db";
import { desc, eq } from "drizzle-orm";
import { enqueueRun, ensureQueues, openQueue } from "@moss/agent";

const [command, ...args] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");
const db = createDb(databaseUrl);

switch (command) {
  case "run": {
    const [agentId, task] = args;
    if (!agentId || !task) throw new Error('Usage: moss-cli run <agentId> "<task>"');
    const boss = openQueue(process.env.QUEUE_DATABASE_URL ?? databaseUrl);
    await boss.start();
    await ensureQueues(boss);
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
  case "incidents": {
    const [anyUser] = await db.select().from(users).limit(1);
    for (const i of await listIncidents(db, anyUser!.orgId, { status: ["new", "in_progress", "on_hold", "resolved"] })) {
      console.log(`${i.id}  ${incidentRef(i.number).padEnd(7)}  ${i.priority}  ${i.status.padEnd(11)}  ${i.title}`);
    }
    break;
  }
  case "changes": {
    const [anyUser] = await db.select().from(users).limit(1);
    for (const c of await listChanges(db, anyUser!.orgId)) {
      console.log(`${c.id}  ${changeRef(c.number).padEnd(6)}  ${c.type.padEnd(9)}  ${c.status.padEnd(11)}  ${c.title}`);
    }
    break;
  }
  default:
    console.log('Commands: run <agentId> "<task>" | agents | runs [agentId] | incidents | changes');
}
process.exit(0);
