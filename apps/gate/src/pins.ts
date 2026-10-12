// Trust on first use for devices that receive credentials (Settings, Security): the first TLS certificate or SSH
// host key a device presents is remembered, and a different one later stops the call before the credential is sent.
import { getSetting, writeAudit } from "@moss/core";
import { hostPins, type Database } from "@moss/db";
import { canonicalAddress } from "@moss/policy";
import { and, eq, inArray } from "drizzle-orm";
import type { ToolboxClient, ToolboxResponse } from "./toolbox-client.js";

type Actor = { type: "agent" | "system"; id: string | null };

/** A toolbox call that carries a credential: it only goes to the device seen the first time, and to a trusted certificate if the owner asks. */
export async function credentialCall(
  db: Database,
  toolbox: ToolboxClient,
  orgId: string,
  call: { tool: string; args: Record<string, unknown>; targets: string[]; signal?: AbortSignal },
  actor: Actor,
): Promise<ToolboxResponse> {
  const [pinHosts, verifyTls] = await Promise.all([getSetting(db, orgId, "tools.pin_hosts"), getSetting(db, orgId, "tools.verify_tls")]);
  const hosts = call.targets.map((t) => canonicalAddress(t)).filter((h): h is string => h !== null);
  const pins = pinHosts ? await loadPins(db, orgId, hosts) : undefined;
  const res = await toolbox.call(call.tool, call.args, call.signal, { ...(pins ? { pins } : {}), ...(verifyTls ? { verifyTls: true } : {}) });
  if (pins && res.seen) await recordPins(db, orgId, { known: pins, seen: res.seen, hosts, renewals: verifyTls }, actor);
  return res;
}

/** The pins for these addresses, keyed as the toolbox expects ("tls:<address>:<port>"). */
export async function loadPins(db: Database, orgId: string, hosts: string[]): Promise<Record<string, string>> {
  if (hosts.length === 0) return {};
  const rows = await db.select().from(hostPins).where(and(eq(hostPins.orgId, orgId), inArray(hostPins.host, hosts)));
  return Object.fromEntries(rows.map((r) => [`${r.kind}:${r.host}:${r.port}`, r.fingerprint]));
}

const KEY = /^(tls|ssh):(.+):(\d+)$/;

/**
 * Remembers new devices, and records a changed key for a person to look at. A new port on a known device with a key
 * it hasn't shown before waits for a person too (fingerprint left empty). `renewals`: certificates were verified
 * against a certificate authority, so a renewed one replaces the pin.
 */
export async function recordPins(db: Database, orgId: string, r: { known: Record<string, string>; seen: Record<string, string>; hosts: string[]; renewals: boolean }, actor: Actor) {
  for (const [key, fingerprint] of Object.entries(r.seen)) {
    const m = KEY.exec(key);
    if (!m || typeof fingerprint !== "string" || !fingerprint || fingerprint.length > 200) continue;
    const [, kind, host, portText] = m as unknown as [string, "tls" | "ssh", string, string];
    // Only the devices this call was allowed to reach.
    if (!r.hosts.includes(host)) continue;
    const port = Number(portText);
    const where = and(eq(hostPins.orgId, orgId), eq(hostPins.kind, kind), eq(hostPins.host, host), eq(hostPins.port, port));
    const pinned = r.known[key];
    const audit = (action: string, details: Record<string, unknown>) =>
      writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action, targetType: "host", targetId: `${host}:${port}`, details: { kind, ...details } });
    if (pinned === fingerprint) continue;
    if (pinned !== undefined && pinned !== "" && kind === "tls" && r.renewals) {
      await db.update(hostPins).set({ fingerprint, changedTo: null, changedAt: null, updatedAt: new Date() }).where(where);
      await audit("host_pin.renewed", { from: pinned, to: fingerprint });
    } else if (pinned !== undefined) {
      const [row] = await db.select({ changedTo: hostPins.changedTo }).from(hostPins).where(where);
      if (row?.changedTo === fingerprint) continue;
      await db.update(hostPins).set({ changedTo: fingerprint, changedAt: new Date(), updatedAt: new Date() }).where(where);
      await audit("host_pin.mismatch", { pinned, presented: fingerprint });
    } else {
      const others = Object.entries(r.known).filter(([k]) => KEY.exec(k)?.[1] === kind && KEY.exec(k)?.[2] === host).map(([, v]) => v);
      const unexplained = others.length > 0 && !others.includes(fingerprint) && !(kind === "tls" && r.renewals);
      await db
        .insert(hostPins)
        .values({ orgId, kind, host, port, ...(unexplained ? { fingerprint: "", changedTo: fingerprint, changedAt: new Date() } : { fingerprint }) })
        .onConflictDoNothing();
      if (unexplained) await audit("host_pin.mismatch", { pinned: null, presented: fingerprint, newPort: true });
    }
  }
}
