// Docker, through a read-only socket proxy on each host. Health: a monitor per host, and per container that's
// meant to be running (a restart policy), down when it's stopped, restarting in a loop or unhealthy. Inventory:
// each host and its containers. Updates: which containers' images have a newer version in their registry.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import type { FeatureOutput, IntegrationDef, InventoryItem } from "./types.js";

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status?: string;
  health?: string;
  restartCount?: number;
  exitCode?: number;
  restartPolicy?: string;
  compose?: string;
  shouldRun: boolean;
  updateAvailable?: boolean;
}
interface HostResult {
  host: string;
  port: number;
  ok: boolean;
  error?: string;
  result?: { host?: string; version?: string; containers: Container[] };
}
interface MultiHost {
  hosts: HostResult[];
}

/** Whether a container is fine, and if not, what's wrong. Containers with no restart policy may be off on purpose. */
export function containerStatus(c: Container): { status: "up" | "degraded" | "down"; message: string } | null {
  if (c.state === "restarting") return { status: "down", message: `Restarting over and over (${c.restartCount ?? "?"} restarts, last exit code ${c.exitCode ?? "?"})` };
  if (c.health === "unhealthy") return { status: "down", message: `Running but unhealthy (${c.status ?? "health check failing"})` };
  if (c.state === "running") return { status: "up", message: c.status ?? "Running" };
  if (!c.shouldRun) return null;
  return { status: "down", message: `${c.state === "exited" ? `Exited with code ${c.exitCode ?? "?"}` : c.state}, but set to restart (${c.restartPolicy})` };
}

export function dockerHealth(r: MultiHost): FeatureOutput {
  const alerts: ParsedAlert[] = [];
  let problems = 0;
  let watched = 0;
  for (const h of r.hosts) {
    const label = h.result?.host ?? h.host;
    alerts.push({
      key: `host:${h.host}`,
      name: `Docker on ${label}`,
      status: h.ok ? "up" : "down",
      message: h.ok ? `Docker ${h.result?.version ?? ""} answering, ${h.result?.containers.length ?? 0} containers`.replace("  ", " ") : (h.error ?? "Not answering"),
    });
    for (const c of h.result?.containers ?? []) {
      const s = containerStatus(c);
      if (!s || (!c.shouldRun && s.status === "up")) continue; // only containers meant to stay up
      watched++;
      if (s.status !== "up") problems++;
      alerts.push({
        key: `container:${h.host}/${c.name}`,
        name: `${c.name} on ${label}`,
        status: s.status,
        message: s.message,
        ...(typeof c.restartCount === "number" ? { values: { restarts: c.restartCount } } : {}),
      });
    }
  }
  return { alerts, summary: `${r.hosts.filter((h) => h.ok).length} of ${r.hosts.length} host(s) answering, ${watched} container(s) watched, ${problems} with problems` };
}

export function dockerInventory(r: MultiHost): FeatureOutput {
  const inventory: InventoryItem[] = [];
  const updates: string[] = [];
  for (const h of r.hosts.filter((x) => x.ok && x.result)) {
    inventory.push({ externalId: `host/${h.host}`, name: h.result!.host, kind: "server", ips: [h.host], macs: [], details: { dockerVersion: h.result!.version } });
    for (const c of h.result!.containers) {
      if (c.updateAvailable) updates.push(`${c.name} (${c.image})`);
      inventory.push({
        externalId: `container/${h.host}/${c.name}`,
        name: c.name,
        kind: "container",
        ips: [],
        macs: [],
        parentExternalId: `host/${h.host}`,
        createWithoutIp: true,
        details: {
          image: c.image,
          state: c.state,
          ...(c.compose ? { compose: c.compose } : {}),
          ...(c.updateAvailable !== undefined ? { updateAvailable: c.updateAvailable } : {}),
        },
      });
    }
  }
  const checked = r.hosts.some((h) => h.result?.containers.some((c) => c.updateAvailable !== undefined));
  return {
    inventory,
    ...(checked ? { summary: updates.length ? `${updates.length} update(s) available: ${updates.slice(0, 8).join(", ")}${updates.length > 8 ? "…" : ""}` : "Every image is up to date" } : {}),
  };
}

export const DOCKER: IntegrationDef = {
  key: "docker",
  name: "Docker",
  description: "Watch the containers that should be running on each Docker host, keep them in the inventory, and know when their images have updates.",
  plan: "free",
  connection: {
    defaultPort: 2375,
    tls: false,
    hint: "On each host, run a read-only socket proxy so MOSS never gets full control of Docker (full Docker access is root): for example tecnativa/docker-socket-proxy with CONTAINERS=1, IMAGES=1, INFO=1 and POST=0, published on port 2375 to your LAN only.",
    multipleHosts: { label: "Docker hosts", hint: "One per line: each host's address, with :port if it isn't the default." },
  },
  test: {
    op: "containers",
    describe: (r) => {
      const m = r as MultiHost;
      return m.hosts.map((h) => (h.ok ? `${h.result?.host ?? h.host}: Docker ${h.result?.version ?? "?"}, ${h.result?.containers.length ?? 0} containers` : `${h.host}: ${h.error}`)).join(". ") + ".";
    },
  },
  ops: { containers: { tool: "docker_api_containers" }, updates: { tool: "docker_api_containers", args: () => ({ checkUpdates: true }) } },
  features: [
    {
      key: "health",
      label: "Health checks",
      description: "Every 5 minutes: each host answering, and each container with a restart policy running, not restarting in a loop, and not unhealthy.",
      everyMs: 5 * 60_000,
      op: "containers",
      apply: (r) => dockerHealth(r as MultiHost),
    },
    {
      key: "inventory",
      label: "Containers in the inventory",
      description: "Every 6 hours: each host and its containers as assets, with their image and Compose project. Removed containers are marked missing.",
      everyMs: 6 * 60 * 60_000,
      op: "containers",
      apply: (r) => dockerInventory(r as MultiHost),
    },
    {
      key: "updates",
      label: "Image update check",
      description: "Daily: asks each image's registry (Docker Hub, GHCR...) for the tag's latest digest, and marks containers whose image has a newer version. Sends only the image names to the registries.",
      everyMs: 24 * 60 * 60_000,
      op: "updates",
      apply: (r) => dockerInventory(r as MultiHost),
    },
  ],
  agentTools: ["docker_api_containers"],
  tools: ["docker_api_containers"],
};
