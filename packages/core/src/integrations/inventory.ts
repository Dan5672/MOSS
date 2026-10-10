// Integrations' devices in the inventory. Matched to assets by the product's own id first (from an earlier
// sync), then MAC, then IP. Unlocked matches get the integration's name (only over an automatic one), kind, maker,
// model and OS (only where empty), its details under attributes.<integration>, and what they run on. New ones are
// added when their address is in an allowed network, or when the product reports them itself (VMs, containers).
// Ones this integration added that have gone are marked missing.
import { assets, networks, type Database } from "@moss/db";
import { contains, parseRange } from "@moss/policy";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { InventoryItem } from "./types.js";

export interface InventoryResult {
  matched: number;
  created: number;
  locked: number;
  skipped: number;
  missing: number;
}

type Asset = typeof assets.$inferSelect;

/** A name nobody chose: the address itself, or a scan's "vendor address" default. */
export function autoNamed(a: Pick<Asset, "name" | "primaryIp" | "primaryMac" | "vendor">): boolean {
  const ip = a.primaryIp ?? "";
  return !a.name.trim() || a.name === ip || a.name === "unknown" || a.name === a.primaryMac || (!!a.vendor && a.name === `${a.vendor} ${ip}`);
}

const cut = (s: string | undefined, n = 200) => (s ? s.slice(0, n) : undefined);

export async function applyIntegrationInventory(db: Database, orgId: string, key: string, items: InventoryItem[], now = new Date()): Promise<InventoryResult> {
  const result: InventoryResult = { matched: 0, created: 0, locked: 0, skipped: 0, missing: 0 };
  const nets = await db.select({ cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, orgId));
  const ranges = (status: string) => nets.filter((r) => r.status === status).flatMap((r) => parseRange(r.cidr) ?? []);
  const [allowed, offLimits] = [ranges("allowed"), ranges("off_limits")];
  const usable = (ip: string) => {
    const r = parseRange(ip);
    return !!r && allowed.some((a) => contains(a, r)) && !offLimits.some((o) => contains(o, r));
  };
  const live = and(eq(assets.orgId, orgId), ne(assets.status, "retired"));
  const idPath = sql`${assets.attributes} -> ${key} ->> 'externalId'`;
  const seen = new Map<string, string>(); // externalId -> asset id
  const parents: { assetId: string; parent: string }[] = [];

  for (const item of items.slice(0, 2000)) {
    const macs = item.macs.map((m) => m.toLowerCase());
    const [byId] = await db.select().from(assets).where(and(live, sql`${idPath} = ${item.externalId}`)).limit(1);
    const [byMac] = byId || !macs.length ? [] : await db.select().from(assets).where(and(live, inArray(assets.primaryMac, macs))).limit(1);
    const [byIp] =
      byId || byMac || !item.ips.length
        ? []
        : await db
            .select()
            .from(assets)
            .where(and(live, sql`host(${assets.primaryIp}) in (${sql.join(item.ips.map((ip) => sql`${ip}`), sql`, `)})`))
            .orderBy(desc(assets.lastSeenAt))
            .limit(1);
    // An IP match whose MAC differs is another device on that address now.
    const match = byId ?? byMac ?? (byIp && (!byIp.primaryMac || !macs.length || macs.includes(byIp.primaryMac)) ? byIp : undefined);
    const details = { externalId: item.externalId, ...(item.name ? { name: item.name } : {}), ...item.details, syncedAt: now.toISOString() };

    if (match) {
      result.matched++;
      seen.set(item.externalId, match.id);
      if (item.parentExternalId) parents.push({ assetId: match.id, parent: item.parentExternalId });
      if (match.locked) {
        result.locked++;
        continue;
      }
      const patch: Partial<typeof assets.$inferInsert> = { attributes: { ...match.attributes, [key]: details }, lastSeenAt: now, updatedAt: now };
      if (match.status === "missing") patch.status = "active";
      if (item.name && autoNamed(match)) patch.name = cut(item.name)!;
      if (item.kind && match.kind === "unknown") patch.kind = item.kind;
      if (item.vendor && !match.vendor) patch.vendor = cut(item.vendor);
      if (item.model && !match.model) patch.model = cut(item.model);
      if (item.os && !match.os) patch.os = cut(item.os);
      if (macs[0] && !match.primaryMac) patch.primaryMac = macs[0];
      const ip = item.ips.find(usable);
      if (ip && !match.primaryIp) patch.primaryIp = ip;
      await db.update(assets).set(patch).where(eq(assets.id, match.id));
      continue;
    }

    const ip = item.ips.find(usable);
    if (!ip && !item.createWithoutIp) {
      result.skipped++;
      continue;
    }
    const [created] = await db
      .insert(assets)
      .values({
        orgId,
        name: cut(item.name) ?? ip ?? item.externalId,
        kind: item.kind ?? "unknown",
        vendor: cut(item.vendor) ?? null,
        model: cut(item.model) ?? null,
        os: cut(item.os) ?? null,
        primaryIp: ip ?? null,
        primaryMac: macs[0] ?? null,
        attributes: { [key]: details },
        source: `integration:${key}`,
        confidence: 70,
      })
      .returning({ id: assets.id });
    seen.set(item.externalId, created!.id);
    if (item.parentExternalId) parents.push({ assetId: created!.id, parent: item.parentExternalId });
    result.created++;
  }

  // What each runs on, now every item has an asset.
  for (const p of parents) {
    const parentId = seen.get(p.parent);
    if (parentId) await db.update(assets).set({ attributes: sql`${assets.attributes} || ${JSON.stringify({ parentAssetId: parentId })}::jsonb` }).where(and(eq(assets.id, p.assetId), eq(assets.locked, false)));
  }

  // Ones this integration added that it no longer reports (a deleted VM, a removed container).
  const mine = await db
    .select({ id: assets.id, externalId: sql<string>`${idPath}` })
    .from(assets)
    .where(and(eq(assets.orgId, orgId), eq(assets.source, `integration:${key}`), eq(assets.status, "active"), eq(assets.locked, false)));
  const gone = mine.filter((a) => a.externalId && !seen.has(a.externalId)).map((a) => a.id);
  if (gone.length && items.length) {
    await db.update(assets).set({ status: "missing", updatedAt: now }).where(inArray(assets.id, gone));
    result.missing = gone.length;
  }
  return result;
}
