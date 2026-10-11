// Moss reminds everyone in #general before an uploaded HTTPS certificate runs out: 30 days and 7 days ahead.
// (MOSS's own certificate authority renews its certificates by itself, so it needs no reminders.)
import { certificateReminderDue, ensureGeneralChannel, getSetting, postMessage, setSetting, type UploadedCertificateInfo } from "@moss/core";
import { agents, conversationMembers, type Database } from "@moss/db";
import { and, eq, ne } from "drizzle-orm";
import { MOSS_TEMPLATE } from "./lifecycle.js";

/** Posts a reminder if one is due. Returns the days-ahead it reminded about, or null. */
export async function remindCertificateExpiry(db: Database, orgId: string, now = new Date()): Promise<number | null> {
  const info = (await getSetting(db, orgId, "https.certificate")) as Partial<UploadedCertificateInfo>;
  if (!info.notAfter || !info.subject || !info.fingerprint) return null;
  const due = certificateReminderDue(info as UploadedCertificateInfo, now);
  if (due === null) return null;
  const [moss] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.templateKey, MOSS_TEMPLATE), ne(agents.status, "fired")));
  if (!moss) return null;
  const days = Math.max(0, Math.ceil((new Date(info.notAfter).getTime() - now.getTime()) / 86_400_000));
  // Both reminders count as sent once the later one goes out (no 30-day note after the 7-day one).
  await setSetting(db, orgId, "https.certificate", { ...info, reminded: [7, 30].filter((at) => at >= due) });
  const general = await ensureGeneralChannel(db, orgId);
  await db.insert(conversationMembers).values({ conversationId: general, agentId: moss.id }).onConflictDoNothing();
  await postMessage(
    db,
    orgId,
    general,
    { type: "agent", id: moss.id },
    `**MOSS's HTTPS certificate runs out ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}** (${new Date(info.notAfter).toDateString()}).\n\n` +
      `It's the one uploaded for ${info.subject}. Upload a renewed one in Settings → HTTPS, or switch back to MOSS's own certificate there. Once it expires, browsers will warn before opening MOSS.`,
  );
  return due;
}
