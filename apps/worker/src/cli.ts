// Operator CLI (until the web UI lands):
//   moss-cli run <agentId> "<task>"                  queue a manual run
//   moss-cli agents                                  list agents
//   moss-cli runs [agentId]                          show recent runs
//   moss-cli incidents                               list open incidents
//   moss-cli changes                                 list recent change requests
//   moss-cli approve <changeId> <userEmail> [note]   approve a change as that user
//   moss-cli reject <changeId> <userEmail> [note]    reject a change as that user
import { approveChange, changeRef, incidentRef, listChanges, listIncidents, rejectChange } from "@moss/core";
import { agentRuns, agents, createDb, users } from "@moss/db";
import { desc, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { enqueueRun, RUN_QUEUE } from "./worker.js";

const [command, ...args] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");
const db = createDb(databaseUrl);

async function userByEmail(email: string | undefined) {
  if (!email) throw new Error("A user email is required");
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (!user) throw new Error(`No user ${email}`);
  return user;
}

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
  case "approve":
  case "reject": {
    const [changeId, email, ...note] = args;
    if (!changeId) throw new Error(`Usage: moss-cli ${command} <changeId> <userEmail> [note]`);
    const user = await userByEmail(email);
    const comment = note.join(" ") || undefined;
    const c =
      command === "approve"
        ? await approveChange(db, user.orgId, changeId, user.id, { comment })
        : await rejectChange(db, user.orgId, changeId, user.id, comment);
    console.log(`${changeRef(c.number)} is now ${c.status}`);
    break;
  }
  default:
    console.log('Commands: run <agentId> "<task>" | agents | runs [agentId] | incidents | changes | approve|reject <changeId> <email> [note]');
}
process.exit(0);
