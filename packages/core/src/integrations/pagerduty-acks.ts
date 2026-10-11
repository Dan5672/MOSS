// PagerDuty acknowledgements back in MOSS: kept apart from the definition (which the registry loads) because it
// reaches into incidents and module state.
import { incidents, type Database } from "@moss/db";
import { eq } from "drizzle-orm";
import { addIncidentComment } from "../services/incidents.js";
import { loadModule, updateModuleState } from "../services/modules.js";
import type { PdIncident } from "./pagerduty.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Notes on each MOSS incident who acknowledged or resolved its page, once per change (after the acknowledgements
 * feature has read PagerDuty). Returns how many notes were added.
 */
export async function notePagerdutyChanges(db: Database, orgId: string): Promise<number> {
  const state = (await loadModule(db, orgId, "pagerduty")).state as { pagerduty?: { incidents: PdIncident[] }; noted?: Record<string, string> };
  const noted = { ...(state.noted ?? {}) };
  let added = 0;
  for (const p of state.pagerduty?.incidents ?? []) {
    // Only pages MOSS raised (their key is a MOSS incident id); others on the service aren't MOSS's.
    if (!p.key || !UUID.test(p.key) || !p.status || p.status === "triggered" || noted[p.key] === p.status) continue;
    const [inc] = await db.select({ id: incidents.id, orgId: incidents.orgId }).from(incidents).where(eq(incidents.id, p.key));
    if (!inc || inc.orgId !== orgId) continue;
    noted[p.key] = p.status;
    const who = p.by ? ` by ${p.by}` : "";
    // Only a link to PagerDuty itself.
    const url = p.url && /^https:\/\/[a-z0-9-]+\.pagerduty\.com\/\S*$/i.test(p.url) ? ` ${p.url}` : "";
    await addIncidentComment(db, orgId, inc.id, `${p.status === "acknowledged" ? "Acknowledged" : "Resolved"} in PagerDuty${who}.${url}`, { type: "system", id: null });
    added++;
  }
  // Keep the record small: only pages PagerDuty still lists.
  const keys = new Set((state.pagerduty?.incidents ?? []).map((p) => p.key));
  await updateModuleState(db, orgId, "pagerduty", { noted: Object.fromEntries(Object.entries(noted).filter(([k]) => keys.has(k))) });
  return added;
}
