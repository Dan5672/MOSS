// Platform tools: actions on MOSS itself (inventory, networks). They run in the worker
// against the database, gated by the agent's skill grants AND its role permissions.
import {
  addAsset,
  listNetworks,
  reportNetwork,
  searchAssets,
  updateAsset,
  type Permission,
} from "@moss/core";
import type { Database } from "@moss/db";
import { z } from "zod";
import type { GateClient } from "./gate-client.js";
import { TICKET_TOOLS } from "./ticket-tools.js";

export interface PlatformContext {
  db: Database;
  orgId: string;
  agentId: string;
  gate: GateClient;
  runId: string;
}

export interface PlatformTool {
  name: string;
  description: string;
  permission: Permission;
  args: z.ZodObject;
  run(ctx: PlatformContext, args: any): Promise<unknown>;
}

const assetKinds = z
  .string()
  .regex(/^[a-z_]{2,32}$/)
  .describe("router, switch, access_point, server, workstation, nas, printer, camera, iot, phone, tv, vm, container, ...");

function summarizeAsset(a: Awaited<ReturnType<typeof searchAssets>>[number]) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    ip: a.primaryIp,
    mac: a.primaryMac,
    vendor: a.vendor,
    hostnames: a.hostnames,
    os: a.os,
    notes: a.notes,
    locked: a.locked,
    confidence: a.confidence,
    lastSeen: a.lastSeenAt.toISOString(),
    openPorts: a.services.map((s) => `${s.port}/${s.protocol}${s.name ? ` ${s.name}` : ""}${s.product ? ` (${s.product}${s.version ? ` ${s.version}` : ""})` : ""}`),
    attributes: a.attributes,
  };
}

const INVENTORY_TOOLS: PlatformTool[] = [
  {
    name: "inventory_search",
    description: "Search the asset inventory by free text (name, hostname, vendor, MAC, IP, notes), IP/CIDR, or kind.",
    permission: "assets.read",
    args: z.object({
      query: z.string().max(100).optional(),
      ip: z.string().max(64).optional().describe("IP address or CIDR to search within"),
      kind: assetKinds.optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    run: async ({ db, orgId }, args) => (await searchAssets(db, orgId, args)).map(summarizeAsset),
  },
  {
    name: "inventory_update",
    description: "Update an asset's classification and notes. Locked assets cannot be changed.",
    permission: "assets.manage",
    args: z.object({
      assetId: z.uuid(),
      name: z.string().min(1).max(100).optional(),
      kind: assetKinds.optional(),
      vendor: z.string().max(100).optional(),
      model: z.string().max(100).optional(),
      os: z.string().max(100).optional(),
      notes: z.string().max(2000).optional(),
      confidence: z.number().int().min(0).max(100).optional().describe("How sure you are of this classification, 0-100"),
      attributes: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
    }),
    run: async ({ db, orgId, agentId }, { assetId, ...patch }) => {
      const a = await updateAsset(db, orgId, assetId, patch, { type: "agent", id: agentId });
      return { updated: a.id, name: a.name, kind: a.kind };
    },
  },
  {
    name: "inventory_add",
    description: "Add an asset that scans cannot see. Search first to avoid duplicates.",
    permission: "assets.manage",
    args: z.object({
      name: z.string().min(1).max(100),
      kind: assetKinds.optional(),
      ip: z.string().max(64).optional(),
      mac: z.string().regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/).optional(),
      vendor: z.string().max(100).optional(),
      notes: z.string().max(2000).optional(),
    }),
    run: async ({ db, orgId, agentId }, args) => {
      const a = await addAsset(db, orgId, args, { type: "agent", id: agentId });
      return { added: a.id, name: a.name };
    },
  },
  {
    name: "networks_list",
    description: "List known networks and whether you may scan them (allowed), must not (off_limits), or need a human decision (unknown).",
    permission: "networks.read",
    args: z.object({}),
    run: async ({ db, orgId }) =>
      (await listNetworks(db, orgId)).map((n) => ({ cidr: n.cidr, name: n.name, vlan: n.vlan, status: n.status })),
  },
  {
    name: "network_report",
    description: "Report a network you have learned about. It is recorded as unknown until a human decides whether it may be scanned.",
    permission: "networks.read",
    args: z.object({
      cidr: z.string().max(64),
      name: z.string().max(100).optional(),
      notes: z.string().max(1000).optional().describe("How you learned about this network"),
    }),
    run: async ({ db, orgId, agentId }, args) => reportNetwork(db, orgId, args, { type: "agent", id: agentId }),
  },
];

export const PLATFORM_TOOLS: PlatformTool[] = [...INVENTORY_TOOLS, ...TICKET_TOOLS];

export const PLATFORM_TOOL_MAP: ReadonlyMap<string, PlatformTool> = new Map(PLATFORM_TOOLS.map((t) => [t.name, t]));

export function platformToolSchema(tool: PlatformTool): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.args.strict(), { io: "input" }) as Record<string, unknown>;
  return schema;
}
