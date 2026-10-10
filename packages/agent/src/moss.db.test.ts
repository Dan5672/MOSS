// Moss: hired automatically once there's a model, can't be fired, answers from the docs and the config,
// and other agents consult it with ask_moss.
import { bootstrapOrg, getConversation, listConversations, writeAudit, setSetting } from "@moss/core";
import { agents, agentSkills, models, orgs, providers, skills, users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLibrary, syncBuiltInSkills } from "./library.js";
import { ensureMoss, fireAgent, MOSS_TEMPLATE } from "./lifecycle.js";
import { loadDocs, searchDocs } from "./moss-tools.js";
import { PLATFORM_TOOL_MAP } from "./platform-tools.js";
import { welcomeFromMoss } from "./welcome.js";
import { announceWhatsNew, latestChanges } from "./whats-new.js";
import { remindCertificateExpiry } from "./certificate-reminders.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));

describe("MOSS docs", () => {
  it("are split into sections and searched by the words asked", async () => {
    const docs = await loadDocs(`${LIBRARY_DIR}/docs`);
    expect(docs.length).toBeGreaterThan(15);
    const [top] = searchDocs(docs, "what does secret_scope mean");
    expect(top!.section).toBe("Denial codes");
    expect(searchDocs(docs, "UniFi local account")[0]!.text).toMatch(/Restrict to local access only/);
    // The generated reference answers questions about one tool or setting, behind the written docs.
    expect(searchDocs(docs, "what does nmap_scan do").map((s) => s.section)).toContain("Tool nmap_scan");
    expect(searchDocs(docs, "allow_vulners setting").some((s) => s.text.includes("tools.allow_vulners"))).toBe(true);
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

  it("welcomes each person once, with what's left to set up, and doesn't answer itself", async () => {
    const template = await readFile(`${LIBRARY_DIR}/docs/welcome.md`, "utf8");
    expect(await welcomeFromMoss(db, orgId, template)).toBe(1);
    expect(await welcomeFromMoss(db, orgId, template)).toBe(0); // only once
    const list = await listConversations(db, orgId, ownerId);
    const dm = list.find((c) => c.agentId === mossId)!;
    expect(dm.unread).toBe(1);
    const conv = await getConversation(db, orgId, dm.id, ownerId);
    const body = conv.messages[0]!.body;
    expect(body).toMatch(/^Hi O, I'm Moss/);
    expect(body).toContain("**Allow your network**");
    expect(body).toContain("If you have any questions about how MOSS works, just ask me here.");
    expect(body).not.toContain("{");
    // A person added later gets it too.
    await db.insert(users).values({ orgId, email: "sam@h.test", displayName: "Sam Smith" });
    expect(await welcomeFromMoss(db, orgId, template)).toBe(1);
  });

  it("announces what's new in #general once per version, but not on a brand-new install", async () => {
    const log = ["# What's new", "", "## 0.3.0", "- Dashboards you can arrange.", "", "## 0.2.0", "- Older.", ""].join("\n");
    expect(latestChanges(log)).toEqual({ version: "0.3.0", body: "- Dashboards you can arrange." });
    expect(await announceWhatsNew(db, orgId, log)).toBeNull(); // the org was made today
    await db.update(orgs).set({ createdAt: new Date(Date.now() - 7 * 86_400_000) }).where(eq(orgs.id, orgId));
    expect(await announceWhatsNew(db, orgId, log)).toBeNull(); // already noted for this version
    const next = log.replace("## 0.3.0", ["## 0.4.0", "- Charts.", "", "## 0.3.0"].join("\n"));
    expect(await announceWhatsNew(db, orgId, next)).toBe("0.4.0");
    const general = (await listConversations(db, orgId, ownerId)).find((c) => c.title === "#general")!;
    const msgs = (await getConversation(db, orgId, general.id, ownerId)).messages;
    expect(msgs.at(-1)!.body).toBe(["**What's new in MOSS 0.4.0**", "", "- Charts.", "", "Ask me about any of it."].join("\n"));
    expect(await announceWhatsNew(db, orgId, next)).toBeNull();
  });

  it("reminds about an uploaded certificate 30 and 7 days before it runs out, once each", async () => {
    expect(await remindCertificateExpiry(db, orgId)).toBeNull(); // nothing uploaded
    const notAfter = new Date("2030-02-01T00:00:00Z");
    await setSetting(db, orgId, "https.certificate", { subject: "CN=moss.home", notAfter: notAfter.toISOString(), fingerprint: "AB:CD", reminded: [] });
    expect(await remindCertificateExpiry(db, orgId, new Date("2029-12-01"))).toBeNull();
    expect(await remindCertificateExpiry(db, orgId, new Date("2030-01-05"))).toBe(30);
    expect(await remindCertificateExpiry(db, orgId, new Date("2030-01-06"))).toBeNull();
    expect(await remindCertificateExpiry(db, orgId, new Date("2030-01-29"))).toBe(7);
    expect(await remindCertificateExpiry(db, orgId, new Date("2030-01-31"))).toBeNull();
    const general = (await listConversations(db, orgId, ownerId)).find((c) => c.title === "#general")!;
    const last = (await getConversation(db, orgId, general.id, ownerId)).messages.at(-1)!.body;
    expect(last.startsWith("**MOSS's HTTPS certificate runs out in 3 days**")).toBe(true);
    expect(last).toContain("CN=moss.home");
  });
});
