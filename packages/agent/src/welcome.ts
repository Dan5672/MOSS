// Moss's welcome: once Moss is on an install, every person gets a short direct message from it: a tour,
// what's left to set up, and an invitation to ask questions. A fixed template (library/docs/welcome.md),
// not a model run, so it's instant, free and always accurate. Sent once per person.
import { postMessage, openDm } from "@moss/core";
import { agents, monitors, networks, users, type Database } from "@moss/db";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { MOSS_TEMPLATE } from "./lifecycle.js";

/** What's still to set up, as a short list (or a well-done line). */
async function nextSteps(db: Database, orgId: string, mossId: string): Promise<string> {
  const [[allowed], [team], [checks]] = await Promise.all([
    db.select({ n: count() }).from(networks).where(and(eq(networks.orgId, orgId), eq(networks.status, "allowed"))),
    db.select({ n: count() }).from(agents).where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"), ne(agents.id, mossId))),
    db.select({ n: count() }).from(monitors).where(eq(monitors.orgId, orgId)),
  ]);
  const todo = [
    !allowed?.n && "**Allow your network** under Settings → Networks, so agents may look at it.",
    !team?.n && "**Hire an agent** under Agents (a Network Admin can discover your devices).",
    !checks?.n && "**Add a monitor** under Monitoring for something you care about, like your router or NAS.",
  ].filter(Boolean);
  return todo.length ? `To finish setting up:\n\n${todo.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "You're all set up already. Nice.";
}

export function fillWelcome(template: string, name: string, steps: string): string {
  return template.replaceAll("{name}", name.split(/\s+/)[0] || name).replaceAll("{next_steps}", steps).trim();
}

/** Sends Moss's welcome to everyone who hasn't had it. Returns how many were welcomed. */
export async function welcomeFromMoss(db: Database, orgId: string, template: string): Promise<number> {
  const [moss] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.templateKey, MOSS_TEMPLATE), ne(agents.status, "fired")));
  if (!moss) return 0;
  const pending = await db
    .select({ id: users.id, name: users.displayName, preferences: users.preferences })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.status, "active"), sql`coalesce((${users.preferences}->>'mossWelcomed')::boolean, false) = false`));
  if (!pending.length) return 0;
  const steps = await nextSteps(db, orgId, moss.id);
  for (const u of pending) {
    // Marked first, so a failure can't make Moss send the welcome twice.
    await db
      .update(users)
      .set({ preferences: sql`coalesce(${users.preferences}, '{}'::jsonb) || '{"mossWelcomed": true}'::jsonb` })
      .where(eq(users.id, u.id));
    const conversationId = await openDm(db, orgId, u.id, { type: "agent", id: moss.id });
    await postMessage(db, orgId, conversationId, { type: "agent", id: moss.id }, fillWelcome(template, u.name, steps));
  }
  return pending.length;
}
