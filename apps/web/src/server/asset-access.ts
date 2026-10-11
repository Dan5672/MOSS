// What agents can do with each asset: whether its network is open to them, and whether any of them
// holds a credential scoped to it. The same rules the policy gate applies, worked out for display.
import { agentToolGrants } from "@moss/core";
import { agents, networks, providers, secretGrants, secrets } from "@moss/db";
import { contains, overlaps, parseRange, type IpRange } from "@moss/policy";
import { BUILT_IN_TOOLS } from "@moss/tools";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "./db";
import { workingAgents } from "./people";

export type AccessLevel = "off_limits" | "not_allowed" | "look" | "sign_in";

export interface AssetAccess {
  level: AccessLevel;
  /** The network that decides it: the off-limits one, or the most specific allowed one. */
  network: { id: string; cidr: string; status: string } | null;
  credentials: { id: string; name: string; type: string; agents: { id: string; name: string }[] }[];
}

export const ACCESS_LABEL: Record<AccessLevel, { label: string; tone: "red" | "gray" | "amber" | "green"; help: string }> = {
  off_limits: { label: "Off limits", tone: "red", help: "Its network is off limits: agents can never touch it." },
  not_allowed: { label: "No access", tone: "gray", help: "Its network isn't allowed, so agents can't reach it." },
  look: { label: "Look only", tone: "amber", help: "Agents can scan and check it, but can't sign in to it." },
  sign_in: { label: "Signs in", tone: "green", help: "Agents hold a credential for it." },
};

async function loadScopeData(orgId: string) {
  const [nets, secretRows, providerKeys, grants] = await Promise.all([
    db().select({ id: networks.id, cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, orgId)),
    db().select({ id: secrets.id, name: secrets.name, type: secrets.type, allowedHosts: secrets.allowedHosts }).from(secrets).where(eq(secrets.orgId, orgId)),
    db().select({ id: providers.apiKeySecretId }).from(providers).where(and(eq(providers.orgId, orgId), isNotNull(providers.apiKeySecretId))),
    db()
      .select({ secretId: secretGrants.secretId, agentId: agents.id, name: agents.name })
      .from(secretGrants)
      .innerJoin(agents, eq(agents.id, secretGrants.agentId))
      .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"))),
  ]);
  const modelKeys = new Set(providerKeys.map((p) => p.id));
  return {
    nets: nets.flatMap((n) => {
      const range = parseRange(n.cidr);
      return range ? [{ ...n, range }] : [];
    }),
    creds: secretRows
      .filter((s) => !modelKeys.has(s.id))
      .map((s) => ({
        ...s,
        hosts: s.allowedHosts.map(parseRange).filter((r): r is IpRange => r !== null),
        agents: grants.filter((g) => g.secretId === s.id).map((g) => ({ id: g.agentId, name: g.name })),
      })),
  };
}

function accessFor(ip: string | null, data: Awaited<ReturnType<typeof loadScopeData>>): AssetAccess {
  const target = ip ? parseRange(ip) : null;
  if (!target) return { level: "not_allowed", network: null, credentials: [] };
  const off = data.nets.find((n) => n.status === "off_limits" && overlaps(n.range, target));
  if (off) return { level: "off_limits", network: off, credentials: [] };
  const allowed = data.nets.filter((n) => n.status === "allowed" && contains(n.range, target)).sort((a, b) => Number(a.range.end - a.range.start - (b.range.end - b.range.start)));
  if (!allowed.length) {
    const seen = data.nets.filter((n) => contains(n.range, target)).sort((a, b) => Number(a.range.end - a.range.start - (b.range.end - b.range.start)))[0];
    return { level: "not_allowed", network: seen ?? null, credentials: [] };
  }
  // An empty host list means "any host the agent may reach".
  const credentials = data.creds.filter((c) => c.agents.length && (c.hosts.length === 0 || c.hosts.some((h) => contains(h, target))));
  return {
    level: credentials.length ? "sign_in" : "look",
    network: allowed[0]!,
    credentials: credentials.map(({ id, name, type, agents }) => ({ id, name, type, agents })),
  };
}

export async function assetAccessMap(orgId: string, rows: { id: string; primaryIp: string | null }[]) {
  const data = await loadScopeData(orgId);
  return new Map(rows.map((r) => [r.id, accessFor(r.primaryIp, data)]));
}

export async function assetAccess(orgId: string, ip: string | null) {
  return accessFor(ip, await loadScopeData(orgId));
}

export type CredentialType = "password" | "ssh_key" | "api_token" | "snmp_community";

/** The built-in tools that sign in with each kind of credential. */
export function toolsForCredential(type: CredentialType): string[] {
  const args: Record<CredentialType, string[]> = { password: ["password"], ssh_key: ["key"], api_token: ["token", "apiKey"], snmp_community: ["community"] };
  return [...BUILT_IN_TOOLS.values()].filter((t) => t.manifest.secretArgs?.some((a) => args[type].includes(a))).map((t) => t.manifest.name);
}

/** Working agents, with the tools each already has. */
export async function agentsWithTools(orgId: string) {
  const rows = await db()
    .select({ id: agents.id, name: agents.name, title: agents.title })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"), workingAgents));
  return Promise.all(rows.map(async (a) => ({ ...a, tools: [...(await agentToolGrants(db(), a.id))] })));
}
