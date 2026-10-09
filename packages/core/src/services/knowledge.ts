// The wiki (it began as the knowledge base): pages that agents and people write and keep current. Each page
// has a slug (/wiki/<slug>), may sit under a parent page and be about one asset, and keeps its earlier
// versions. Everything an agent writes here is model output and may quote untrusted network data, so it
// is stored as text and only ever rendered as text (Markdown without HTML).
import { assets, knowledgeNotes, knowledgeRevisions, type Database } from "@moss/db";
import { and, asc, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { writeAudit } from "../store/audit-store.js";
import type { Actor } from "./assets.js";

export interface NoteInput {
  title: string;
  body: string;
  tags?: string[];
  subject?: string | null;
  /** The page this one sits under (null for the top level). Left out on update: unchanged. */
  parentId?: string | null;
  /** The device the page is about. Left out on update: unchanged. */
  assetId?: string | null;
}

export const NOTE_LIMITS = { title: 120, body: 20_000, tags: 10, tag: 32, subject: 120 } as const;

function clean(n: NoteInput) {
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

/** "Living room AP" -> "living-room-ap". */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "page"
  );
}

async function uniqueSlug(db: Pick<Database, "select">, orgId: string, title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(
    (await db.select({ slug: knowledgeNotes.slug }).from(knowledgeNotes).where(and(eq(knowledgeNotes.orgId, orgId), ilike(knowledgeNotes.slug, `${base}%`)))).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Pages matching every given filter, most recently updated first. */
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

export async function getNote(db: Pick<Database, "select">, orgId: string, id: string) {
  const [row] = await db.select().from(knowledgeNotes).where(and(eq(knowledgeNotes.id, id), eq(knowledgeNotes.orgId, orgId)));
  return row ?? null;
}

/** A page by its slug, or by its title (case-insensitive), e.g. for a [[Page]] link. */
export async function findPage(db: Pick<Database, "select">, orgId: string, ref: string) {
  const r = ref.trim();
  const [bySlug] = await db.select().from(knowledgeNotes).where(and(eq(knowledgeNotes.orgId, orgId), eq(knowledgeNotes.slug, r.toLowerCase())));
  if (bySlug) return bySlug;
  const [byTitle] = await db.select().from(knowledgeNotes).where(and(eq(knowledgeNotes.orgId, orgId), ilike(knowledgeNotes.title, escapeLike(r)))).limit(1);
  return byTitle ?? null;
}

/** Every page's place in the tree, for the wiki's index and link resolution. */
export async function listPages(db: Pick<Database, "select">, orgId: string) {
  return db
    .select({ id: knowledgeNotes.id, title: knowledgeNotes.title, slug: knowledgeNotes.slug, parentId: knowledgeNotes.parentId, assetId: knowledgeNotes.assetId, updatedAt: knowledgeNotes.updatedAt })
    .from(knowledgeNotes)
    .where(eq(knowledgeNotes.orgId, orgId))
    .orderBy(asc(knowledgeNotes.title));
}

export async function pagesForAsset(db: Pick<Database, "select">, orgId: string, assetId: string) {
  return db
    .select({ id: knowledgeNotes.id, title: knowledgeNotes.title, slug: knowledgeNotes.slug, updatedAt: knowledgeNotes.updatedAt })
    .from(knowledgeNotes)
    .where(and(eq(knowledgeNotes.orgId, orgId), eq(knowledgeNotes.assetId, assetId)))
    .orderBy(asc(knowledgeNotes.title));
}

/** Earlier versions of a page, newest first. */
export async function pageRevisions(db: Pick<Database, "select">, noteId: string) {
  return db.select().from(knowledgeRevisions).where(eq(knowledgeRevisions.noteId, noteId)).orderBy(desc(knowledgeRevisions.createdAt));
}

/** The parent and asset are the org's own, and a page can't sit under itself or its own children. */
async function checkPlacement(db: Pick<Database, "select">, orgId: string, input: NoteInput, selfId?: string) {
  if (input.assetId) {
    const [a] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.orgId, orgId)));
    if (!a) throw new Error("Asset not found");
  }
  if (!input.parentId) return;
  const pages = await listPages(db, orgId);
  for (let at: string | null | undefined = input.parentId, hops = 0; at; at = pages.find((p) => p.id === at)?.parentId, hops++) {
    if (!pages.some((p) => p.id === at)) throw new Error("Parent page not found");
    if (at === selfId || hops > 50) throw new Error("A page can't sit under itself");
  }
}

const byActor = (actor: Actor, prefix: "createdBy" | "updatedBy") =>
  actor.type === "user" ? { [`${prefix}UserId`]: actor.id } : actor.type === "agent" ? { [`${prefix}AgentId`]: actor.id } : {};

export async function createNote(db: Database, orgId: string, input: NoteInput, actor: Actor) {
  const n = clean(input);
  await checkPlacement(db, orgId, input);
  const slug = await uniqueSlug(db, orgId, n.title);
  const [row] = await db
    .insert(knowledgeNotes)
    .values({
      orgId,
      ...n,
      tags: n.tags ?? [],
      slug,
      parentId: input.parentId ?? null,
      assetId: input.assetId ?? null,
      ...byActor(actor, "createdBy"),
      ...byActor(actor, "updatedBy"),
    })
    .returning();
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "knowledge.create", targetType: "note", targetId: row!.id, details: { title: n.title, slug, subject: n.subject } });
  return row!;
}

/** Updates a page, keeping what it said before as a revision. Its slug stays the same, so links keep working. */
export async function updateNote(db: Database, orgId: string, id: string, input: NoteInput, actor: Actor) {
  const before = await getNote(db, orgId, id);
  if (!before) throw new Error("Note not found");
  const n = clean(input);
  await checkPlacement(db, orgId, input, id);
  const row = await db.transaction(async (tx) => {
    if (before.title !== n.title || before.body !== n.body) {
      await tx.insert(knowledgeRevisions).values({
        noteId: id,
        title: before.title,
        body: before.body,
        editedByUserId: before.updatedByUserId,
        editedByAgentId: before.updatedByAgentId,
        createdAt: before.updatedAt,
      });
    }
    const [r] = await tx
      .update(knowledgeNotes)
      .set({
        ...n,
        tags: n.tags ?? [],
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
        slug: before.slug ?? (await uniqueSlug(tx, orgId, n.title)),
        updatedByUserId: null,
        updatedByAgentId: null,
        ...byActor(actor, "updatedBy"),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeNotes.id, id))
      .returning();
    return r!;
  });
  await writeAudit(db, {
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: "knowledge.update",
    targetType: "note",
    targetId: id,
    details: { from: { title: before.title, body: before.body.slice(0, 2000) }, to: { title: n.title, body: n.body.slice(0, 2000) } },
  });
  return row;
}

export async function deleteNote(db: Database, orgId: string, id: string, actor: Actor) {
  const before = await getNote(db, orgId, id);
  if (!before) throw new Error("Note not found");
  // Child pages move up to the deleted page's parent rather than vanishing from the tree.
  await db.update(knowledgeNotes).set({ parentId: before.parentId }).where(and(eq(knowledgeNotes.parentId, id), ne(knowledgeNotes.id, id)));
  await db.delete(knowledgeNotes).where(eq(knowledgeNotes.id, id));
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "knowledge.delete", targetType: "note", targetId: id, details: { title: before.title, body: before.body.slice(0, 2000) } });
}
