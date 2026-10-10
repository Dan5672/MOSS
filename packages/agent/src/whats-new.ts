// After an upgrade, Moss posts what's new in #general: the newest section of library/docs/changelog.md,
// once per version. A brand-new install skips it (Moss's welcome covers that).
import { ensureGeneralChannel, getSetting, postMessage, setSetting } from "@moss/core";
import { agents, conversationMembers, orgs, type Database } from "@moss/db";
import { and, eq, ne } from "drizzle-orm";
import { MOSS_TEMPLATE } from "./lifecycle.js";

/** The newest section of the changelog: its version and its text. */
export function latestChanges(changelog: string): { version: string; body: string } | null {
  const m = /^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
  return m ? { version: m[1]!.trim(), body: m[2]!.trim() } : null;
}

/** Posts what's new once per version. Returns the version it announced, or null. */
export async function announceWhatsNew(db: Database, orgId: string, changelog: string, now = new Date()): Promise<string | null> {
  const latest = latestChanges(changelog);
  if (!latest) return null;
  const announced = await getSetting(db, orgId, "moss.announced_version");
  if (announced === latest.version) return null;
  const [moss] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.templateKey, MOSS_TEMPLATE), ne(agents.status, "fired")));
  if (!moss) return null; // waits for Moss to be hired
  const [org] = await db.select({ createdAt: orgs.createdAt }).from(orgs).where(eq(orgs.id, orgId));
  await setSetting(db, orgId, "moss.announced_version", latest.version);
  // A new install already gets the welcome; nothing is "new" to it yet.
  if (!org || now.getTime() - org.createdAt.getTime() < 86_400_000) return null;
  const general = await ensureGeneralChannel(db, orgId);
  await db.insert(conversationMembers).values({ conversationId: general, agentId: moss.id }).onConflictDoNothing();
  await postMessage(db, orgId, general, { type: "agent", id: moss.id }, `**What's new in MOSS ${latest.version}**\n\n${latest.body}\n\nAsk me about any of it.`);
  return latest.version;
}
