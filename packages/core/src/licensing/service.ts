// The org's business licence: stored in the setting licence.key (a signed key, not a secret), checked on every
// use. Business integrations work only while it's valid, or in its grace period.
import type { Database } from "@moss/db";
import { INTEGRATIONS } from "../integrations/registry.js";
import type { IntegrationDef } from "../integrations/types.js";
import { notifyPermission } from "../services/notifications.js";
import { getSetting, setSetting } from "../store/settings-store.js";
import { writeAudit } from "../store/audit-store.js";
import { licenceCovers, licenceStatus, verifyLicence, type LicenceStatus } from "./licence.js";

type Actor = { type: "user" | "system"; id: string | null };

export class LicenceError extends Error {}

/** The org's licence and its state now. A stored key that no longer verifies counts as none. */
export async function getLicenceStatus(db: Database, orgId: string, now = new Date()): Promise<LicenceStatus> {
  const text = await getSetting(db, orgId, "licence.key");
  if (!text) return licenceStatus(null, now);
  const check = verifyLicence(text);
  return licenceStatus(check.ok ? check.licence : null, now);
}

/** Checks a key and stores it. An expired key is refused. */
export async function saveLicence(db: Database, orgId: string, text: string, actor: Actor, now = new Date()): Promise<LicenceStatus> {
  const check = verifyLicence(text);
  if (!check.ok) throw new LicenceError(check.error);
  const status = licenceStatus(check.licence, now);
  if (status.state === "expired") throw new LicenceError(`That licence expired on ${new Date(check.licence.expires).toDateString()}.`);
  await setSetting(db, orgId, "licence.key", text.trim().replace(/\s+/g, ""));
  await setSetting(db, orgId, "licence.reminded", {});
  const { id, licensee, features, expires } = check.licence;
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "licence.add", targetType: "setting", targetId: "licence.key", details: { id, licensee, features, expires } });
  return status;
}

export async function removeLicence(db: Database, orgId: string, actor: Actor) {
  await setSetting(db, orgId, "licence.key", "");
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "licence.remove", targetType: "setting", targetId: "licence.key", details: {} });
}

/** Whether an integration may be used: free ones always; business ones only with a licence that covers them. */
export function integrationAllowed(def: Pick<IntegrationDef, "key" | "plan">, status: LicenceStatus): boolean {
  return def.plan !== "business" || licenceCovers(status, def.key);
}

export async function integrationLicensed(db: Database, orgId: string, def: Pick<IntegrationDef, "key" | "plan">, now = new Date()): Promise<boolean> {
  return def.plan !== "business" || integrationAllowed(def, await getLicenceStatus(db, orgId, now));
}

/** The business integration a tool belongs to, if any (its tools only work for agents under a licence). */
export function businessIntegrationForTool(tool: string): IntegrationDef | null {
  return INTEGRATIONS.find((d) => d.plan === "business" && [...(d.agentTools ?? []), ...(d.credential?.tools ?? []), ...Object.values(d.ops).map((o) => o.tool)].includes(tool)) ?? null;
}

/** Tells the people who manage settings 30 and 7 days before the licence expires, and when it stops. Returns what was sent. */
export async function remindLicenceExpiry(db: Database, orgId: string, now = new Date()): Promise<string | null> {
  const status = await getLicenceStatus(db, orgId, now);
  if (!status.licence) return null;
  const sent = ((await getSetting(db, orgId, "licence.reminded")) as { id?: string; at?: string[] }) ?? {};
  const already = sent.id === status.licence.id ? (sent.at ?? []) : [];
  const due = status.state === "expired" ? "stopped" : status.state === "grace" ? "expired" : status.daysLeft! <= 7 ? "7" : status.daysLeft! <= 30 ? "30" : null;
  if (!due || already.includes(due)) return null;
  // Later reminders cover the earlier ones.
  const order = ["30", "7", "expired", "stopped"];
  await setSetting(db, orgId, "licence.reminded", { id: status.licence.id, at: order.slice(0, order.indexOf(due) + 1) });
  const until = new Date(status.licence.expires).toDateString();
  const n =
    due === "stopped"
      ? { title: "MOSS's business licence has run out", body: "Business integrations have stopped. Their settings are kept: add a renewed licence in Settings → About to switch them back on." }
      : due === "expired"
        ? { title: "MOSS's business licence has expired", body: `Business integrations keep working until ${new Date(status.stopsAt!).toDateString()}. Add a renewed licence in Settings → About.` }
        : { title: `MOSS's business licence expires in ${status.daysLeft} days`, body: `It runs out on ${until}. Add a renewed licence in Settings → About.` };
  await notifyPermission(db, orgId, "settings.manage", { kind: "licence", ...n, link: "/settings/about#licence" });
  return due;
}
