// Every integration MOSS has, besides Home Assistant (which has its own pages and features). Adding one here gives
// it a settings page, background features, gate operations and a place in Moss's docs check.
import { ADGUARD, PIHOLE } from "./dns-filters.js";
import { DOCKER } from "./docker.js";
import { OPNSENSE, PFSENSE } from "./firewalls.js";
import { NUT } from "./nut.js";
import { TAILSCALE } from "./tailscale.js";
import { PROXMOX, PROXMOX_BACKUP } from "./proxmox.js";
import type { IntegrationDef } from "./types.js";

export const INTEGRATIONS: IntegrationDef[] = [PROXMOX, PROXMOX_BACKUP, DOCKER, OPNSENSE, PFSENSE, NUT, TAILSCALE, PIHOLE, ADGUARD];

export function getIntegration(key: string): IntegrationDef | null {
  return INTEGRATIONS.find((d) => d.key === key) ?? null;
}

/** The integration a built-in tool comes with, if any (its tools still work for agents without it). */
export function integrationForTool(tool: string): IntegrationDef | null {
  return INTEGRATIONS.find((d) => (d.tools ?? d.credential?.tools ?? []).includes(tool)) ?? null;
}
