// The wiki check: after resolving an incident, completing a change or answering a chat, an agent writes down what it
// learned or says why not, and the answer is recorded. Run with MOSS_TEST_DATABASE_URL set.
import { bootstrapOrg, createIncident, getIncident, setSetting } from "@moss/core";
import { agentRuns, models, providers, runSteps, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { MockAdapter, type ScriptedTurn, type TurnInput } from "@moss/llm";
import { asc, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadLibrary, syncBuiltInSkills, type Library } from "./library.js";
import { hireFromTemplate, type Actor } from "./lifecycle.js";
import { runAgent, type GateClient, type RunDeps } from "./runtime.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));
const gate: GateClient = { listTools: async () => [], callTool: async () => ({ allowed: false, code: "unknown_tool", reason: "no network tools here" }) };

const asked = (input: TurnInput) => ("text" in input ? input.text : "");

describe.skipIf(!TEST_DATABASE_URL)("wiki check (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let lib: Library;
  let actor: Actor;
  let modelId: string;
  let script: ScriptedTurn[];
  let adapter: MockAdapter;

  const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({ db, gate, providerFor: () => (adapter = new MockAdapter(script)), ...extra });
  const hire = () => hireFromTemplate(db, actor, { template: lib.templates.get("network-admin")!, modelId });
  const newIncident = (agentId: string) => createIncident(db, actor.orgId, { type: "break_fix", title: "NAS unreachable", assignedAgentId: agentId }, { type: "user", id: actor.userId! });
  const resolve = (incidentId: string) => ({ toolCalls: [{ id: "r", name: "incident_update", input: { incidentId, status: "resolved", note: "Restarted SMB; shares answer" } }] });
  const runRow = async (runId: string | null) => (await db.select().from(agentRuns).where(eq(agentRuns.id, runId!)))[0]!;
  const mossQuestions = async (runId: string | null) =>
    (await db.select().from(runSteps).where(eq(runSteps.runId, runId!)).orderBy(asc(runSteps.seq))).filter((s) => (s.content as { from?: string }).from === "moss");

  beforeAll(async () => {
    ({ db, close } = await createTestDb("wiki_check"));
    lib = await loadLibrary(LIBRARY_DIR);
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    actor = { orgId: boot.org.id, userId: boot.owner.id };
    await syncBuiltInSkills(db, actor.orgId, lib.skills.values());
    const [provider] = await db.insert(providers).values({ orgId: actor.orgId, kind: "anthropic", name: "Claude" }).returning();
    [{ id: modelId }] = await db.insert(models).values({ orgId: actor.orgId, providerId: provider!.id, modelId: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" }).returning();
  });
  afterAll(() => close?.());
  beforeEach(() => setSetting(db, actor.orgId, "knowledge.wiki_check", true));

  it("reminds the agent when it resolves an incident, asks once, and records its reason", async () => {
    const nina = await hire();
    const inc = await newIncident(nina.id);
    script = [
      resolve(inc.id),
      {
        text: "Fixed: SMB had stopped.",
        // The reminder follows the incident_update result, outside the tool-data markers.
        expect: (input) => {
          const content = ("toolResults" in input ? input.toolResults : [])[0]!.content;
          expect(content).toMatch(/<\/tool-data run="[0-9a-f]{16}">\nMOSS: before you finish, record what you learned from INC-\d+/);
        },
      },
      {
        toolCalls: [{ id: "s", name: "wiki_skip", input: { reason: "Covered by How-tos/Restart SMB" } }],
        expect: (input) => expect(asked(input)).toMatch(/^MOSS: you closed INC-\d+ but haven't recorded/),
      },
      { text: "Nothing new." },
    ];
    const out = await runAgent(deps(), { agentId: nina.id, task: "Work the incident", trigger: "ticket", triggerRef: inc.id });
    expect(out).toMatchObject({ status: "succeeded", summary: "Fixed: SMB had stopped." });
    expect(await runRow(out.runId)).toMatchObject({ wikiCheck: "skipped", wikiCheckNote: "Covered by How-tos/Restart SMB" });
    expect(await mossQuestions(out.runId)).toHaveLength(1);
    expect((await getIncident(db, actor.orgId, inc.id))!.comments.map((c) => c.body)).toContain("No wiki update needed: Covered by How-tos/Restart SMB");
  });

  it("records an agent that ignores the question as unanswered, and asks only once", async () => {
    const nina = await hire();
    const inc = await newIncident(nina.id);
    script = [resolve(inc.id), { text: "Fixed." }, { text: "OK." }];
    const out = await runAgent(deps(), { agentId: nina.id, task: "Work the incident", trigger: "ticket", triggerRef: inc.id });
    expect(out).toMatchObject({ status: "succeeded", summary: "Fixed." });
    expect(script).toHaveLength(0);
    expect(await runRow(out.runId)).toMatchObject({ wikiCheck: "unanswered", wikiCheckNote: null });
    expect((await getIncident(db, actor.orgId, inc.id))!.comments.map((c) => c.body)).toContain(
      "No wiki update recorded: the agent finished without writing down what it learned or saying why not.",
    );
  });

  it("doesn't ask an agent that already wrote it down", async () => {
    const nina = await hire();
    const inc = await newIncident(nina.id);
    script = [
      { toolCalls: [{ id: "w", name: "kb_write", input: { title: "NAS SMB service", body: "SMB on 192.168.1.10 stops after updates; restart it.", subject: "192.168.1.10" } }] },
      resolve(inc.id),
      { text: "Fixed and noted." },
    ];
    const out = await runAgent(deps(), { agentId: nina.id, task: "Work the incident", trigger: "ticket", triggerRef: inc.id });
    expect(out).toMatchObject({ status: "succeeded", summary: "Fixed and noted." });
    expect(await mossQuestions(out.runId)).toHaveLength(0);
    expect(adapter.received[0]!.inputs).toHaveLength(3);
    expect(await runRow(out.runId)).toMatchObject({ wikiCheck: "written", wikiCheckNote: "NAS SMB service" });
  });

  it("asks after a chat, and the person still gets the agent's reply", async () => {
    const nina = await hire();
    script = [
      { text: "Got it: the printer moved to the office." },
      {
        toolCalls: [{ id: "w", name: "wiki_write", input: { title: "Printer", body: "The printer is in the office (moved by the owner)." } }],
        expect: (input) => expect(asked(input)).toMatch(/^MOSS: one more thing before your reply goes out/),
      },
      { text: "Saved the printer's new location to the wiki." },
    ];
    const out = await runAgent(deps(), { agentId: nina.id, task: "FYI the printer is in the office now", trigger: "chat", requestedByUserId: actor.userId! });
    expect(out).toMatchObject({ status: "succeeded", summary: "Got it: the printer moved to the office." });
    expect(await runRow(out.runId)).toMatchObject({ wikiCheck: "written", wikiCheckNote: "Printer", summary: "Got it: the printer moved to the office." });
  });

  it("keeps the reply when the extra turn fails", async () => {
    const nina = await hire();
    script = [{ text: "Here's the answer." }]; // the scripted model has nothing more: the wiki question fails
    const out = await runAgent(deps(), { agentId: nina.id, task: "A question", trigger: "chat", requestedByUserId: actor.userId! });
    expect(out).toMatchObject({ status: "succeeded", summary: "Here's the answer." });
    expect(await runRow(out.runId)).toMatchObject({ wikiCheck: "unanswered" });
  });

  it("is off when the setting is off, and for consulted runs", async () => {
    const nina = await hire();
    await setSetting(db, actor.orgId, "knowledge.wiki_check", false);
    const inc = await newIncident(nina.id);
    script = [resolve(inc.id), { text: "Fixed." }];
    const off = await runAgent(deps(), { agentId: nina.id, task: "Work it", trigger: "ticket", triggerRef: inc.id });
    expect(await runRow(off.runId)).toMatchObject({ wikiCheck: null });

    await setSetting(db, actor.orgId, "knowledge.wiki_check", true);
    script = [{ text: "Here's what I know." }];
    const consulted = await runAgent(deps({ consulting: true }), { agentId: nina.id, task: "A question from a teammate", trigger: "event" });
    expect(consulted).toMatchObject({ status: "succeeded" });
    expect(await runRow(consulted.runId)).toMatchObject({ wikiCheck: null });
    expect(await mossQuestions(consulted.runId)).toHaveLength(0);
  });
});
