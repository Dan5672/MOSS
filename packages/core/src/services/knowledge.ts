// Knowledge base: short notes that agents and people share. Everything an agent writes here is model
// output and may quote untrusted network data, so it is stored and shown as plain text only.
import { knowledgeNotes, type Database } from "@moss/db";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { writeAudit } from "../store/audit-store.js";
import type { Actor } from "./assets.js";

export interface NoteInput {
  title: string;
  body: string;
  tags?: string[];
  subject?: string | null;
}

export const NOTE_LIMITS = { title: 120, body: 4000, tags: 10, tag: 32, subject: 120 } as const;

function clean(n: NoteInput): NoteInput {
  const tags = [...new Set((n.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, NOTE_LIMITS.tags);
  for (const t of tags) if (t.length > NOTE_LIMITS.tag || !/^[a-z0-9][a-z0-9._-]*$/.test(t)) throw new Error(`Invalid tag "${t}"`);
  const title = n.title.trim();
  const body = n.body.trim();
  if (!title || title.length > NOTE_LIMITS.title) throw new Error(`A title of 1–${NOTE_LIMITS.title} characters is required`);
  if (!body || body.length > NOTE_LIMITS.body) throw new Error(`A body of 1–${NOTE_LIMITS.body} characters is required`);
  const subject = n.subject?.trim() || null;
  if (subject && subject.length > NOTE_LIMITS.subject) throw new Error(`The subject can be at most ${NOTE_LIMITS.subject} characters`);
  return { title, body, tags, subject };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Notes matching every given filter, most recently updated first. */
export async function searchNotes(db: Database, orgId: string, f: { query?: string; subject?: string; tag?: string; limit?: number } = {}) {
  const conds = [eq(knowledgeNotes.orgId, orgId)];
  if (f.query?.trim()) {
    const q = `%${escapeLike(f.query.trim())}%`;
    conds.push(or(ilike(knowledgeNotes.title, q), ilike(knowledgeNotes.body, q), ilike(knowledgeNotes.subject, q), sql`${knowledgeNotes.tags}::text ilike ${q}`)!);
  }
  if (f.subject?.trim()) conds.push(ilike(knowledgeNotes.subject, escapeLike(f.subject.trim())));
  if (f.tag?.trim()) conds.push(sql`${knowledgeNotes.tags} ? ${f.tag.trim().toLowerCase()}`);
  return db
    .select()
    .from(knowledgeNotes)
    .where(and(...conds))
    .orderBy(desc(knowledgeNotes.updatedAt))
    .limit(Math.min(Math.max(f.limit ?? 20, 1), 100));
}

export async function getNote(db: Database, orgId: string, id: string) {
  const [row] = await db.select().from(knowledgeNotes).where(and(eq(knowledgeNotes.id, id), eq(knowledgeNotes.orgId, orgId)));
  return row ?? null;
}

const byActor = (actor: Actor, prefix: "createdBy" | "updatedBy") =>
  actor.type === "user" ? { [`${prefix}UserId`]: actor.id } : actor.type === "agent" ? { [`${prefix}AgentId`]: actor.id } : {};

export async function createNote(db: Database, orgId: string, input: NoteInput, actor: Actor) {
  const n = clean(input);
  const [row] = await db
    .insert(knowledgeNotes)
    .values({ orgId, ...n, tags: n.tags ?? [], ...byActor(actor, "createdBy"), ...byActor(actor, "updatedBy") })
    .returning();
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "knowledge.create", targetType: "note", targetId: row!.id, details: { title: n.title, subject: n.subject } });
  return row!;
}

export async function updateNote(db: Database, orgId: string, id: string, input: NoteInput, actor: Actor) {
  const before = await getNote(db, orgId, id);
  if (!before) throw new Error("Note not found");
  const n = clean(input);
  const [row] = await db
    .update(knowledgeNotes)
    .set({ ...n, tags: n.tags ?? [], updatedByUserId: null, updatedByAgentId: null, ...byActor(actor, "updatedBy"), updatedAt: new Date() })
    .where(eq(knowledgeNotes.id, id))
    .returning();
  await writeAudit(db, {
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: "knowledge.update",
    targetType: "note",
    targetId: id,
    details: { from: { title: before.title, body: before.body }, to: { title: n.title, body: n.body } },
  });
  return row!;
}

export async function deleteNote(db: Database, orgId: string, id: string, actor: Actor) {
  const before = await getNote(db, orgId, id);
  if (!before) throw new Error("Note not found");
  await db.delete(knowledgeNotes).where(eq(knowledgeNotes.id, id));
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "knowledge.delete", targetType: "note", targetId: id, details: { title: before.title, body: before.body } });
}
