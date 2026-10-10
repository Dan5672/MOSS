// Asset inventory: deterministic ingestion of scan results, plus search and edits.
import { assets, assetServices, networks, type Database } from "@moss/db";
import { contains, parseRange } from "@moss/policy";
import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { writeAudit } from "../store/audit-store.js";
import { emitEvent } from "./events.js";

export interface DiscoveredPort {
  protocol: "tcp" | "udp";
  port: number;
  state: string;
  service?: string;
  product?: string;
  version?: string;
}

export interface DiscoveredHost {
  ip: string;
  mac?: string;
  vendor?: string;
  hostnames?: string[];
  ports?: DiscoveredPort[];
}

export interface IngestResult {
  created: string[];
  updated: string[];
}

export type Actor = { type: "user" | "agent" | "system"; id: string | null };

const MAX_HOSTNAMES = 10;

/** A device's DNS name, without the domain: "nas" for nas.home.lan. */
export function shortHostname(name: string): string {
  return /^[0-9.:]+$/.test(name) ? name : (name.split(".")[0] || name);
}

function defaultName(h: DiscoveredHost): string {
  const host = h.hostnames?.[0];
  return host ? shortHostname(host) : h.vendor && !h.vendor.startsWith("(") ? `${h.vendor} ${h.ip}` : h.ip;
}

/**
 * A name made up because nothing better was known: the bare IP, or something built around it
 * ("camera-10.0.0.7", "Espressif 10.0.0.9"). Those are replaced once a device's real name turns up.
 */
export function isPlaceholderName(name: string, ip: string | null): boolean {
  if (!ip) return false;
  const n = name.trim();
  return n === ip || n.endsWith(` ${ip}`) || n.endsWith(`-${ip}`) || n.endsWith(`_${ip}`) || n.endsWith(`(${ip})`);
}

async function networkFor(db: Database, orgId: string, ip: string): Promise<string | null> {
  const target = parseRange(ip);
  if (!target) return null;
  const rows = await db.select({ id: networks.id, cidr: networks.cidr }).from(networks).where(eq(networks.orgId, orgId));
  // Most specific network wins.
  let best: { id: string; size: bigint } | null = null;
  for (const n of rows) {
    const r = parseRange(n.cidr);
    if (r && contains(r, target) && (!best || r.end - r.start < best.size)) best = { id: n.id, size: r.end - r.start };
  }
  return best?.id ?? null;
}

/**
 * Records scan results. Matches existing assets by MAC first, then by IP (only when the IP's
 * current asset has no conflicting MAC). Locked assets only get their last-seen time refreshed.
 */
export async function ingestDiscoveredHosts(
  db: Database,
  orgId: string,
  hosts: DiscoveredHost[],
  source: string,
): Promise<IngestResult> {
  const result: IngestResult = { created: [], updated: [] };
  const now = new Date();
  for (const h of hosts) {
    if (!parseRange(h.ip)) continue;
    const mac = h.mac?.toLowerCase();
    const [byMac] = mac
      ? await db.select().from(assets).where(and(eq(assets.orgId, orgId), eq(assets.primaryMac, mac), ne(assets.status, "retired")))
      : [];
    const [byIp] = byMac
      ? []
      : await db
          .select()
          .from(assets)
          .where(and(eq(assets.orgId, orgId), sql`${assets.primaryIp} = ${h.ip}::inet`, ne(assets.status, "retired")))
          .orderBy(desc(assets.lastSeenAt))
          .limit(1);
    // An IP match with a different MAC is a different device that took over the address.
    const existing = byMac ?? (byIp && (!mac || !byIp.primaryMac || byIp.primaryMac === mac) ? byIp : undefined);

    let assetId: string;
    if (existing) {
      assetId = existing.id;
      const patch: Partial<typeof assets.$inferInsert> = { lastSeenAt: now, status: "active", updatedAt: now };
      if (!existing.locked) {
        patch.primaryIp = h.ip;
        if (mac && !existing.primaryMac) patch.primaryMac = mac;
        if (h.vendor && !existing.vendor) patch.vendor = h.vendor;
        const names = [...new Set([...existing.hostnames, ...(h.hostnames ?? [])])].slice(0, MAX_HOSTNAMES);
        if (names.length !== existing.hostnames.length) patch.hostnames = names;
        if (names[0] && isPlaceholderName(existing.name, existing.primaryIp)) patch.name = shortHostname(names[0]);
        if (existing.primaryIp !== h.ip) patch.networkId = await networkFor(db, orgId, h.ip);
      }
      await db.update(assets).set(patch).where(eq(assets.id, assetId));
      result.updated.push(assetId);
    } else {
      const [row] = await db
        .insert(assets)
        .values({
          orgId,
          name: defaultName(h),
          primaryIp: h.ip,
          primaryMac: mac ?? null,
          vendor: h.vendor ?? null,
          hostnames: (h.hostnames ?? []).slice(0, MAX_HOSTNAMES),
          networkId: await networkFor(db, orgId, h.ip),
          source,
          confidence: 60,
        })
        .returning({ id: assets.id });
      assetId = row!.id;
      result.created.push(assetId);
      await emitEvent(db, orgId, { type: "asset.discovered", payload: { assetId } });
    }

    for (const p of h.ports ?? []) {
      if (p.state !== "open") continue;
      const values = { name: p.service ?? null, product: p.product ?? null, version: p.version ?? null, lastSeenAt: now };
      await db
        .insert(assetServices)
        .values({ assetId, protocol: p.protocol, port: p.port, ...values })
        .onConflictDoUpdate({ target: [assetServices.assetId, assetServices.protocol, assetServices.port], set: values });
    }
  }
  return result;
}

export interface AssetSearch {
  query?: string;
  ip?: string;
  kind?: string;
  limit?: number;
}

export async function searchAssets(db: Database, orgId: string, q: AssetSearch) {
  const filters: SQL[] = [eq(assets.orgId, orgId), ne(assets.status, "retired")];
  if (q.ip) filters.push(sql`${assets.primaryIp} <<= ${q.ip}::inet`);
  if (q.kind) filters.push(eq(assets.kind, q.kind));
  if (q.query) {
    const like = `%${q.query.replace(/[%_\\]/g, "\\$&")}%`;
    filters.push(
      or(
        ilike(assets.name, like),
        ilike(assets.vendor, like),
        ilike(assets.notes, like),
        ilike(assets.primaryMac, like),
        sql`${assets.hostnames}::text ilike ${like}`,
        sql`host(${assets.primaryIp}) ilike ${like}`,
      )!,
    );
  }
  const rows = await db
    .select()
    .from(assets)
    .where(and(...filters))
    .orderBy(desc(assets.lastSeenAt))
    .limit(Math.min(q.limit ?? 50, 200));
  if (rows.length === 0) return [];
  const services = await db
    .select()
    .from(assetServices)
    .where(inArray(assetServices.assetId, rows.map((r) => r.id)));
  return rows.map((a) => ({ ...a, services: services.filter((s) => s.assetId === a.id) }));
}

export interface AssetPatch {
  name?: string;
  kind?: string;
  vendor?: string;
  model?: string;
  os?: string;
  notes?: string;
  confidence?: number;
  attributes?: Record<string, unknown>;
}

export class AssetLockedError extends Error {
  constructor() {
    super("This asset is locked by a user and cannot be changed by agents");
  }
}

export async function updateAsset(db: Database, orgId: string, assetId: string, patch: AssetPatch, actor: Actor) {
  const [asset] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.orgId, orgId)));
  if (!asset) throw new Error("Asset not found");
  if (asset.locked && actor.type === "agent") throw new AssetLockedError();
  const { attributes, ...rest } = patch;
  const set: Partial<typeof assets.$inferInsert> = { ...rest, updatedAt: new Date() };
  if (attributes) set.attributes = { ...asset.attributes, ...attributes };
  const [updated] = await db.update(assets).set(set).where(eq(assets.id, assetId)).returning();
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "asset.update", targetType: "asset", targetId: assetId, details: { patch } });
  return updated!;
}

export interface NewAsset {
  name: string;
  kind?: string;
  ip?: string;
  mac?: string;
  vendor?: string;
  notes?: string;
}

export async function addAsset(db: Database, orgId: string, input: NewAsset, actor: Actor) {
  if (input.ip && !parseRange(input.ip)) throw new Error("Invalid IP address");
  const [row] = await db
    .insert(assets)
    .values({
      orgId,
      name: input.name,
      kind: input.kind ?? "unknown",
      primaryIp: input.ip ?? null,
      primaryMac: input.mac?.toLowerCase() ?? null,
      vendor: input.vendor ?? null,
      notes: input.notes ?? null,
      networkId: input.ip ? await networkFor(db, orgId, input.ip) : null,
      source: actor.type === "agent" ? `agent:${actor.id}` : actor.type,
      confidence: actor.type === "user" ? 100 : 50,
    })
    .returning();
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "asset.add", targetType: "asset", targetId: row!.id, details: { input } });
  return row!;
}

export async function setAssetLocked(db: Database, orgId: string, assetId: string, locked: boolean, userId: string) {
  await db.update(assets).set({ locked, updatedAt: new Date() }).where(and(eq(assets.id, assetId), eq(assets.orgId, orgId)));
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: locked ? "asset.lock" : "asset.unlock", targetType: "asset", targetId: assetId });
}
