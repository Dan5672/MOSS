// The gate keeps the agent library in step: built-in skills, core skills and Moss (the worker's role can't).
import { bootstrapOrg } from "@moss/core";
import { agents, models, providers, skills, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { and, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLibrarySync } from "./library-sync.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));

describe.skipIf(!TEST_DATABASE_URL)("library sync (gate)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_library"));
    ({ org: { id: orgId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "llama", displayName: "Llama" });
    await startLibrarySync(db, LIBRARY_DIR, () => {}, 3_600_000);
  });
  afterAll(() => close?.());

  it("syncs the built-in skills and hires Moss", async () => {
    const rows = await db.select().from(skills).where(eq(skills.orgId, orgId));
    expect(rows.map((s) => s.key).sort()).toEqual([
      "asset-inventory",
      "aws-account",
      "change-management",
      "config-backups",
      "device-logs",
      "device-power",
      "firewall-actions",
      "home-assistant",
      "home-dns-actions",
      "homelab-integrations",
      "incident-management",
      "monitoring-response",
      "moss-expert",
      "network-discovery",
      "network-insight",
      "network-wiki",
      "security-baseline",
      "server-actions",
      "server-checks",
      "service-desk",
      "service-health",
      "team-memory",
      "unifi-actions",
      "vulnerability-scanning",
      "workplace-directory",
    ]);
    expect(await db.select().from(agents).where(and(eq(agents.orgId, orgId), eq(agents.templateKey, "moss")))).toHaveLength(1);
  });
});
