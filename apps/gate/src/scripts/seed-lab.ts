// Seeds a lab org for end-to-end testing against deploy/lab/compose.lab.yml.
// Prints the agent id to use with the gate API.
import { bootstrapOrg } from "@moss/core";
import { agents, agentSkills, createDb, models, networks, orgs, providers, skills } from "@moss/db";

const db = createDb();
const existing = await db.select().from(orgs).limit(1);
const orgId =
  existing[0]?.id ??
  (await bootstrapOrg(db, { orgName: "MOSS Lab", ownerEmail: "owner@lab.local", ownerName: "Lab Owner", ownerPassword: "lab-owner-password-1" })).org.id;

const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Lab (mock)" }).returning();
const [model] = await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "mock", displayName: "Mock" }).returning();
const [agent] = await db
  .insert(agents)
  .values({ orgId, name: "Lab Netadmin", title: "Network Admin", systemPrompt: "lab", modelId: model!.id })
  .returning();
const [skill] = await db
  .insert(skills)
  .values({
    orgId,
    key: `lab-discovery-${Date.now()}`,
    name: "Lab discovery",
    description: "Discovery tools for the lab",
    instructions: "lab",
    toolGrants: ["nmap_scan", "arp_scan", "ping", "dns_lookup"],
  })
  .returning();
await db.insert(agentSkills).values({ agentId: agent!.id, skillId: skill!.id });
await db
  .insert(networks)
  .values([
    { orgId, cidr: "172.30.10.0/24", name: "Lab allowed", status: "allowed", source: "user" },
    { orgId, cidr: "172.30.66.0/24", name: "Lab off-limits", status: "off_limits", source: "user" },
  ])
  .onConflictDoNothing();

console.log(agent!.id);
process.exit(0);
