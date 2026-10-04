// Seeds the lab (deploy/lab/compose.lab.yml): org, networks, the scripted lab model, and a
// Network Admin hired from the template library. Prints the agent id.
import { hireFromTemplate, loadLibrary, syncBuiltInSkills } from "@moss/agent";
import { bootstrapOrg, setNetworkStatus } from "@moss/core";
import { createDb, models, orgs, providers, users } from "@moss/db";
import { fileURLToPath } from "node:url";

const db = createDb();
const lib = await loadLibrary(process.env.MOSS_LIBRARY_DIR ?? fileURLToPath(new URL("../../../../library", import.meta.url)));

const [existing] = await db.select().from(orgs).limit(1);
const orgId =
  existing?.id ??
  (await bootstrapOrg(db, { orgName: "MOSS Lab", ownerEmail: "owner@lab.local", ownerName: "Lab Owner", ownerPassword: "lab-owner-password-1" })).org.id;
const [owner] = await db.select().from(users).limit(1);
const actor = { orgId, userId: owner!.id };

await syncBuiltInSkills(db, orgId, lib.skills.values());
await setNetworkStatus(db, orgId, { cidr: "172.30.10.0/24", status: "allowed", name: "Lab allowed" }, actor.userId);
await setNetworkStatus(db, orgId, { cidr: "172.30.66.0/24", status: "off_limits", name: "Lab off-limits" }, actor.userId);

const [provider] = await db
  .insert(providers)
  .values({ orgId, kind: "openai_compatible", name: "Lab model (scripted)", baseUrl: "http://lab-llm:8080/v1" })
  .returning();
const [model] = await db
  .insert(models)
  .values({ orgId, providerId: provider!.id, modelId: "lab-model", displayName: "Lab model", inputPricePerMTok: "1", outputPricePerMTok: "5" })
  .returning();
const agent = await hireFromTemplate(db, actor, { template: lib.templates.get("network-admin")!, modelId: model!.id });

console.log(agent.id);
process.exit(0);
