// Networks and their scan permission. Only humans can mark a network allowed or off-limits;
// agents and sensors can only report networks, which start as "unknown" (denied by default).
import { networks, type Database } from "@moss/db";
import { canonicalCidr, parseRange } from "@moss/policy";
import { and, asc, eq } from "drizzle-orm";
import { writeAudit } from "../store/audit-store.js";
import type { Actor } from "./assets.js";

export async function listNetworks(db: Database, orgId: string) {
  return db.select().from(networks).where(eq(networks.orgId, orgId)).orderBy(asc(networks.cidr));
}

/** Records a network an agent or sensor has seen. Never changes the status of a known network. */
export async function reportNetwork(
  db: Database,
  orgId: string,
  input: { cidr: string; name?: string; notes?: string },
  actor: Actor,
): Promise<{ id: string; created: boolean; cidr: string }> {
  const cidr = canonicalCidr(input.cidr);
  if (!cidr) throw new Error("Invalid CIDR");
  const [row] = await db
    .insert(networks)
    .values({
      orgId,
      cidr,
      name: input.name ?? null,
      notes: input.notes ?? null,
      status: "unknown",
      source: actor.type === "user" ? "user" : actor.type === "agent" ? "agent" : "sensor",
    })
    .onConflictDoNothing()
    .returning({ id: networks.id });
  if (row) {
    await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "network.report", targetType: "network", targetId: row.id, details: { cidr } });
    return { id: row.id, created: true, cidr };
  }
  const [existing] = await db.select({ id: networks.id }).from(networks).where(and(eq(networks.orgId, orgId), eq(networks.cidr, cidr)));
  return { id: existing!.id, created: false, cidr };
}

/** Human-only (networks.manage): decides whether agents may scan a network. */
export async function setNetworkStatus(
  db: Database,
  orgId: string,
  input: { cidr: string; status: "allowed" | "off_limits" | "unknown"; name?: string },
  userId: string,
) {
  const cidr = canonicalCidr(input.cidr);
  if (!cidr) throw new Error("Invalid CIDR");
  const values = { status: input.status, ...(input.name ? { name: input.name } : {}), updatedAt: new Date() };
  const [row] = await db
    .insert(networks)
    .values({ orgId, cidr, source: "user", ...values })
    .onConflictDoUpdate({ target: [networks.orgId, networks.cidr], set: values })
    .returning();
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: "network.set_status", targetType: "network", targetId: row!.id, details: { cidr, status: input.status } });
  return row!;
}

/** The DNS server scans use for this network's device names (usually the router), or none. */
export async function setNetworkDns(db: Database, orgId: string, networkId: string, dnsServer: string | null, userId: string) {
  const ip = dnsServer?.trim() || null;
  if (ip) {
    const r = parseRange(ip);
    if (!r || r.start !== r.end) throw new Error("The DNS server must be a single IP address, e.g. 192.168.1.1");
  }
  const [row] = await db.update(networks).set({ dnsServer: ip, updatedAt: new Date() }).where(and(eq(networks.id, networkId), eq(networks.orgId, orgId))).returning();
  if (!row) throw new Error("Network not found");
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: "network.set_dns", targetType: "network", targetId: row.id, details: { cidr: row.cidr, dnsServer: ip } });
  return row;
}
