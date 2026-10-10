// Three task ideas for an agent, most relevant first: its own open incidents, monitors that are down (if
// it responds to monitoring), then tasks that fit its skills. Pure, so it's easy to test.

/** Ideas per skill, in priority order (whatever order the agent's skills come in). Skills that only change
 * things (with approval) have none. */
const BY_SKILL: Record<string, string[]> = {
  "network-discovery": ["Discover devices on all allowed networks, then identify and classify any new or unidentified ones."],
  "asset-inventory": ["Go through the inventory and name and classify any assets that are still unidentified."],
  "monitoring-response": ["Check every monitor that is down or degraded and find out why."],
  "service-health": ["Check that the known servers and their main services are reachable, and report anything that isn't."],
  "incident-management": ["Review the open incidents and move forward any you can."],
  "security-baseline": ["Review open ports on servers and IoT devices and flag anything risky."],
  "service-desk": ["Summarise the state of the network in plain language: what's healthy, what needs attention."],
  "network-insight": ["Name devices using the UniFi console and name lookups, and update the inventory."],
  "server-checks": ["Check disk space, failed services and stopped containers on the servers you can reach."],
  "homelab-integrations": ["Check storage pool and disk health on the NAS and hypervisor, and report any problems."],
  "config-backups": ["Back up the configuration of the devices you manage."],
  "team-memory": ["Write down what you know about the router and the main servers in the knowledge base."],
};

const FALLBACK = ["Introduce yourself: what can you do with the tools you have?", "Look around and tell me what you'd check first.", "Summarise anything that needs my attention."];

export interface SuggestionContext {
  skills: string[];
  incidents: { ref: string; title: string }[];
  downMonitors: { name: string }[];
}

export function taskSuggestions(c: SuggestionContext, count = 3): string[] {
  const out: string[] = [];
  for (const i of c.incidents) out.push(`Work ${i.ref}: ${i.title}. Find the cause and propose a fix.`);
  if (c.skills.includes("monitoring-response")) for (const m of c.downMonitors) out.push(`The monitor "${m.name}" is down. Find out why.`);
  for (const [skill, ideas] of Object.entries(BY_SKILL)) if (c.skills.includes(skill)) out.push(...ideas);
  out.push(...FALLBACK);
  return [...new Set(out)].slice(0, count);
}
