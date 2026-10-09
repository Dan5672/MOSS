// @mentions in comments. "@Nina" or "@Vic Viewer" refers to an agent or a person in the org by name; the
// longest matching name wins, so "@Vic Viewer" isn't read as "@Vic". Names are matched case-insensitively
// and must end at a word boundary.
import { agents, notifications, users, type Database } from "@moss/db";
import { and, eq, ne } from "drizzle-orm";

export interface Mention {
  type: "agent" | "user";
  id: string;
}

export interface Mentionable extends Mention {
  name: string;
}

/** Everyone who can be mentioned in the org: active agents and active people. */
export async function mentionables(db: Pick<Database, "select">, orgId: string): Promise<Mentionable[]> {
  const [agentRows, userRows] = await Promise.all([
    db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"))),
    db.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, orgId), eq(users.status, "active"))),
  ]);
  return [...agentRows.map((a) => ({ type: "agent" as const, ...a })), ...userRows.map((u) => ({ type: "user" as const, ...u }))];
}

/** The agents and people a text @mentions, each once, in order of first mention. */
export function parseMentions(text: string, people: Mentionable[]): Mention[] {
  const byLength = [...people].filter((p) => p.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const found: Mention[] = [];
  const seen = new Set<string>();
  for (let i = text.indexOf("@"); i !== -1; i = text.indexOf("@", i + 1)) {
    if (i > 0 && /[\w.]/.test(text[i - 1]!)) continue; // an email address, not a mention
    const rest = text.slice(i + 1);
    const hit = byLength.find((p) => rest.toLowerCase().startsWith(p.name.toLowerCase()) && !/[\w-]/.test(rest[p.name.length] ?? ""));
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    found.push({ type: hit.type, id: hit.id });
  }
  return found;
}

/** The display name of whoever wrote a comment. */
export async function actorName(db: Pick<Database, "select">, actor: { type: "user" | "agent" | "system"; id: string | null }): Promise<string> {
  if (actor.type === "agent" && actor.id) return (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.id)))[0]?.name ?? "An agent";
  if (actor.type === "user" && actor.id) return (await db.select({ name: users.displayName }).from(users).where(eq(users.id, actor.id)))[0]?.name ?? "Someone";
  return "MOSS";
}

/** Tells each person mentioned (other than the author) where they were mentioned. */
export async function notifyMentioned(
  db: Pick<Database, "insert">,
  orgId: string,
  mentions: Mention[],
  author: { type: string; id: string | null; name: string },
  where: { ref: string; link: string; body: string },
) {
  const people = mentions.filter((m) => m.type === "user" && !(author.type === "user" && author.id === m.id));
  if (!people.length) return;
  await db.insert(notifications).values(
    people.map((m) => ({
      orgId,
      userId: m.id,
      kind: "mention",
      title: `${author.name} mentioned you on ${where.ref}`,
      body: where.body.slice(0, 500),
      link: where.link,
    })),
  );
}
