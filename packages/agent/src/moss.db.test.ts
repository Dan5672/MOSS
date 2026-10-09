// Moss: hired automatically once there's a model, can't be fired, answers from the docs and the config,
// and other agents consult it with ask_moss.
import { bootstrapOrg, writeAudit } from "@moss/core";
import { agents, agentSkills, models, providers, skills, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLibrary, syncBuiltInSkills } from "./library.js";
import { ensureMoss, fireAgent, MOSS_TEMPLATE } from "./lifecycle.js";
import { loadDocs, searchDocs } from "./moss-tools.js";
import { PLATFORM_TOOL_MAP } from "./platform-tools.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));

describe("MOSS docs", () => {
  it("are split into sections and searched by the words asked", async () => {
    const docs = await loadDocs(`${LIBRARY_DIR}/docs`);
    expect(docs.length).toBeGreaterThan(15);
    const [top] = searchDocs(docs, "what does secret_scope mean");
    expect(top!.section).toBe("Denial codes");
    expect(searchDocs(docs, "UniFi local account")[0]!.text).toMatch(/Restrict to local access only/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Moss (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  let mossId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("agent_moss"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    const lib = await loadLibrary(LIBRARY_DIR);
    await syncBuiltInSkills(db, orgId, lib.skills.values());
  });
  afterAll(() => close?.());

  it("is hired once there's a model, with only the MOSS expert skill, and only once", async () => {
    const template = (await loadLibrary(LIBRARY_DIR)).templates.get(MOSS_TEMPLATE)!;
    expect(await ensureMoss(db, orgId, template)).toBeNull(); // no model yet
    const [p] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    await db.insert(models).values({ orgId, providerId: p!.id, modelId: "m", displayName: "M" });
    mossId = (await ensureMoss(db, orgId, template))!;
    expect(mossId).toBeTruthy();
    const [moss] = await db.select().from(agents).where(eq(agents.id, mossId));
    expect(moss).toMatchObject({ name: "Moss", templateKey: "moss", status: "active" });
    const granted = await db.select({ key: skills.key }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(eq(agentSkills.agentId, mossId));
    expect(granted.map((g) => g.key)).toEqual(["moss-expert"]);
    expect(await ensureMoss(db, orgId, template)).toBeNull();
    await expect(fireAgent(db, { orgId, userId: ownerId }, mossId)).rejects.toThrow(/can't be fired/);
  });

  it("reads this install's config, never secret values, and other agents consult it with ask_moss", async () => {
    const [nina] = await db.insert(agents).values({ orgId, name: "Nina", title: "Network Admin", systemPrompt: "x" }).returning();
    await writeAudit(db, { orgId, actorType: "agent", actorId: nina!.id, action: "tool.denied", targetType: "tool", targetId: "nmap_scan", details: { code: "target_not_allowed", reason: "10.9.0.0/16 isn't allowed" } });
    const config = PLATFORM_TOOL_MAP.get("moss_config_read")!;
    const denials = (await config.run({ db, orgId, agentId: mossId, gate: {} as never, runId: "r" }, { section: "denials" })) as { agent: string; code: string }[];
    expect(denials[0]).toMatchObject({ agent: "Nina", tool: "nmap_scan", code: "target_not_allowed" });

    const asked: string[] = [];
    const ask = PLATFORM_TOOL_MAP.get("ask_moss")!;
    const consult = async (agentId: string, task: string) => {
      asked.push(`${agentId}:${task}`);
      return { status: "succeeded", summary: "Allow 10.9.0.0/16 on the Networks page." };
    };
    const ctx = { db, orgId, agentId: nina!.id, gate: {} as never, runId: "r", consult };
    expect(await ask.run(ctx, { question: "Why was my scan of 10.9.0.0/16 denied?" })).toEqual({ answer: "Allow 10.9.0.0/16 on the Networks page." });
    expect(asked[0]).toMatch(new RegExp(`^${mossId}:Nina \\(Network Admin\\) asks you about MOSS`));
    expect(await ask.run({ ...ctx, agentId: mossId }, { question: "Am I me?" })).toEqual({ error: "You are Moss." });
  });
});
