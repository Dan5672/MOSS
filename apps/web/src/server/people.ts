import "server-only";
import { mentionables } from "@moss/core";
import { agents, users } from "@moss/db";
import { and, eq, ne } from "drizzle-orm";
import { db } from "./db";

/** Everyone a ticket can be assigned to: active agents and users. Values are "agent:<id>" / "user:<id>". */
export async function assigneeOptions(orgId: string) {
  const [agentRows, userRows] = await Promise.all([
    db().select({ id: agents.id, name: agents.name, title: agents.title }).from(agents).where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"))),
    db().select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, orgId), eq(users.status, "active"))),
  ]);
  return [
    { value: "", label: "Unassigned" },
    ...agentRows.map((a) => ({ value: `agent:${a.id}`, label: `${a.name} (${a.title}) — agent` })),
    ...userRows.map((u) => ({ value: `user:${u.id}`, label: u.name })),
  ];
}

/** Names for display: id -> name for agents and users. */
/** Agents and people who can be @mentioned, for comment boxes. */
export async function mentionOptions(orgId: string) {
  return (await mentionables(db(), orgId)).map((m) => ({ name: m.name, kind: m.type === "agent" ? "agent" : "person" }));
}

export async function nameLookup(orgId: string) {
  const [agentRows, userRows] = await Promise.all([
    db().select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.orgId, orgId)),
    db().select({ id: users.id, name: users.displayName }).from(users).where(eq(users.orgId, orgId)),
  ]);
  const map = new Map<string, string>([...agentRows.map((a) => [a.id, a.name] as const), ...userRows.map((u) => [u.id, u.name] as const)]);
  return (id: string | null | undefined, fallback = "System") => (id ? (map.get(id) ?? "Unknown") : fallback);
}
