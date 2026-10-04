// Agent runtime against Postgres with a scripted LLM and a fake gate. Run with MOSS_TEST_DATABASE_URL set.
import { bootstrapOrg, setNetworkStatus, setSetting } from "@moss/core";
import { agentRuns, agents, agentSkills, assets, budgets, models, providers, runSteps, tokenUsage, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { MockAdapter, type ScriptedTurn } from "@moss/llm";
import { asc, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadLibrary, syncBuiltInSkills, type Library } from "./library.js";
import { fireAgent, hireFromTemplate, pauseAgent, type Actor } from "./lifecycle.js";
import { runAgent, type GateClient, type GateToolResponse } from "./runtime.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));

const NMAP_SPEC = {
  name: "nmap_scan",
  class: "read",
  description: "scan",
  inputSchema: { type: "object", properties: { targets: { type: "array" }, profile: { type: "string" } } },
};

describe.skipIf(!TEST_DATABASE_URL)("agent runtime (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let lib: Library;
  let actor: Actor;
  let modelId: string;
  let script: ScriptedTurn[];
  let adapter: MockAdapter;
  const gateCalls: { tool: string; args: unknown; runId?: string }[] = [];

  // Fake gate: allows the LAN, denies everything else, and returns a canned scan.
  const gate: GateClient = {
    listTools: async () => [NMAP_SPEC],
    callTool: async (req): Promise<GateToolResponse> => {
      gateCalls.push(req);
      const targets = (req.args as { targets: string[] }).targets;
      if (!targets.every((t) => t.startsWith("192.168.1."))) {
        return { allowed: false, code: "target_off_limits", reason: "Target overlaps off-limits network 10.66.0.0/16" };
      }
      return {
        allowed: true,
        ok: true,
        result: {
          hosts: [
            {
              ip: "192.168.1.10",
              status: "up",
              mac: "aa:bb:cc:00:00:10",
              vendor: "Synology",
              hostnames: ["nas.lan"],
              ports: [{ protocol: "tcp", port: 5000, state: "open", service: "http" }],
            },
            { ip: "192.168.1.20", status: "up", mac: "aa:bb:cc:00:00:20", hostnames: [], ports: [] },
            { ip: "192.168.1.30", status: "down", hostnames: [], ports: [] },
          ],
        },
      };
    },
  };

  const deps = () => ({ db, gate, providerFor: () => (adapter = new MockAdapter(script)) });

  async function hire(templateKey = "network-admin") {
    return hireFromTemplate(db, actor, { template: lib.templates.get(templateKey)!, modelId });
  }

  beforeAll(async () => {
    ({ db, close } = await createTestDb("agent_runtime"));
    lib = await loadLibrary(LIBRARY_DIR);
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    actor = { orgId: boot.org.id, userId: boot.owner.id };
    await syncBuiltInSkills(db, actor.orgId, lib.skills.values());
    await syncBuiltInSkills(db, actor.orgId, lib.skills.values()); // idempotent
    const [provider] = await db.insert(providers).values({ orgId: actor.orgId, kind: "anthropic", name: "Claude" }).returning();
    [{ id: modelId }] = await db
      .insert(models)
      .values({ orgId: actor.orgId, providerId: provider!.id, modelId: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" })
      .returning();
    await setNetworkStatus(db, actor.orgId, { cidr: "192.168.1.0/24", status: "allowed" }, actor.userId);
  });
  afterAll(() => close?.());
  beforeEach(() => {
    gateCalls.length = 0;
  });

  it("hires from a template with skills, schedules and a reporting line", async () => {
    const manager = await hire("it-manager");
    const nina = await hire("network-admin");
    expect(nina).toMatchObject({ name: "Nina", title: "Network Admin", templateKey: "network-admin", effort: "medium", maxStepsPerRun: 30 });
    expect(nina.reportsToAgentId).toBe(manager.id);
    expect(manager.reportsToUserId).toBe(actor.userId);
    expect(await db.select().from(agentSkills).where(eq(agentSkills.agentId, nina.id))).toHaveLength(2);
  });

  it("runs a discovery task end to end: scan, denial, inventory, classification", async () => {
    const nina = await hire();
    const updateTurn: ScriptedTurn = {
      toolCalls: [{ id: "t5", name: "inventory_update", input: { assetId: "set-below", kind: "nas", notes: "Synology DSM on 5000/tcp", confidence: 90 } }],
    };
    script = [
      { toolCalls: [{ id: "t1", name: "networks_list", input: {} }] },
      {
        toolCalls: [
          { id: "t2", name: "nmap_scan", input: { targets: ["192.168.1.0/24"], profile: "ping" } },
          { id: "t3", name: "nmap_scan", input: { targets: ["10.66.0.0/16"], profile: "ping" } },
        ],
        expect: (input) => {
          const results = "toolResults" in input ? input.toolResults : [];
          expect(JSON.parse(results[0]!.content)).toEqual([{ cidr: "192.168.1.0/24", name: null, vlan: null, status: "allowed" }]);
        },
      },
      {
        toolCalls: [{ id: "t4", name: "inventory_search", input: { query: "nas" } }],
        expect: (input) => {
          const [scan, denied] = "toolResults" in input ? input.toolResults : [];
          expect(JSON.parse(scan!.content).inventory).toEqual({ newAssets: 2, updatedAssets: 0 });
          expect(denied).toMatchObject({ isError: true, content: expect.stringContaining("DENIED by policy (target_off_limits)") });
        },
      },
      {
        ...updateTurn,
        expect: (input) => {
          const [search] = "toolResults" in input ? input.toolResults : [];
          const found = JSON.parse(search!.content);
          expect(found).toHaveLength(1);
          expect(found[0].openPorts).toEqual(["5000/tcp http"]);
          // The scripted model "reads" the asset id from the search result.
          (updateTurn.toolCalls![0]!.input as { assetId: string }).assetId = found[0].id;
        },
      },
      { text: "Found 2 devices on 192.168.1.0/24 and classified the Synology NAS. 10.66.0.0/16 is off-limits." },
    ];
    const outcome = await runAgent(deps(), { agentId: nina.id, task: "Discover devices on allowed networks.", trigger: "manual" });

    expect(outcome).toMatchObject({ status: "succeeded", summary: expect.stringContaining("classified the Synology NAS") });
    expect(gateCalls.map((c) => c.runId)).toEqual([outcome.runId, outcome.runId]);

    const nas = (await db.select().from(assets).where(eq(assets.primaryIp, "192.168.1.10")))[0]!;
    expect(nas).toMatchObject({ kind: "nas", confidence: 90, source: `agent:${nina.id}` });
    expect(await db.select().from(assets).where(eq(assets.primaryIp, "192.168.1.30"))).toHaveLength(0); // down hosts are not recorded

    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, outcome.runId!)).orderBy(asc(runSteps.seq));
    expect(steps.filter((s) => s.kind === "policy_denied")).toHaveLength(1);
    expect(steps.at(-1)!.kind).toBe("message");

    const usage = await db.select().from(tokenUsage).where(eq(tokenUsage.runId, outcome.runId!));
    expect(usage).toHaveLength(5);
    // Mock turns use 100 input + 50 output tokens, priced at Sonnet 5.5 rates ($2 / $10 per MTok).
    expect(Number(usage[0]!.costUsd)).toBeCloseTo((100 * 2 + 50 * 10) / 1e6, 8);

    // The system prompt carries the role, rules and skills; the tools include gate and platform tools.
    const session = adapter.received[0]!.opts;
    expect(session.system).toContain("## Network Discovery");
    expect(session.tools.map((t) => t.name).sort()).toEqual([
      "inventory_add",
      "inventory_search",
      "inventory_update",
      "network_report",
      "networks_list",
      "nmap_scan",
    ]);
    expect(session.effort).toBe("medium");
  });

  it("refuses platform tools the agent was not granted", async () => {
    const morgan = await hire("it-manager"); // service-desk + asset-inventory: no network_report
    script = [{ toolCalls: [{ id: "x", name: "network_report", input: { cidr: "10.0.0.0/8" } }] }, { text: "ok" }];
    const outcome = await runAgent(deps(), { agentId: morgan.id, task: "t", trigger: "chat" });
    expect(outcome.status).toBe("succeeded");
    const results = (await db.select().from(runSteps).where(eq(runSteps.runId, outcome.runId!))).filter((s) => s.kind === "tool_result");
    expect(results[0]!.content).toMatchObject({ isError: true, content: expect.stringContaining("not available") });
  });

  it("stops a running agent when the kill switch is pulled", async () => {
    const nina = await hire();
    script = [
      {
        toolCalls: [{ id: "a", name: "networks_list", input: {} }],
        // Pulled while the agent is mid-run: the next model call must not happen.
        expect: () => setSetting(db, actor.orgId, "agents.kill_switch", true),
      },
      { text: "never reached" },
    ];
    const outcome = await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "manual" });
    expect(outcome).toMatchObject({ status: "aborted", summary: expect.stringContaining("kill switch") });
    expect(await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "manual" })).toMatchObject({ status: "skipped" });
    await setSetting(db, actor.orgId, "agents.kill_switch", false);
  });

  it("pauses an agent that hits its hard budget", async () => {
    const nina = await hire();
    await db.insert(budgets).values({ orgId: actor.orgId, agentId: nina.id, period: "day", unit: "tokens", hardLimit: "100" });
    script = [{ toolCalls: [{ id: "a", name: "networks_list", input: {} }] }, { text: "never reached" }];
    const outcome = await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "schedule" });
    expect(outcome).toMatchObject({ status: "aborted", summary: expect.stringContaining("budget") });
    const [after] = await db.select().from(agents).where(eq(agents.id, nina.id));
    expect(after).toMatchObject({ status: "paused", pausedReason: "Hard budget limit reached" });
  });

  it("aborts on repeated identical tool calls", async () => {
    const nina = await hire();
    const same = { toolCalls: [{ id: "s", name: "networks_list", input: {} }] };
    script = [same, same, same, same, { text: "never reached" }];
    const outcome = await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "manual" });
    expect(outcome).toMatchObject({ status: "aborted", summary: expect.stringContaining("Loop detected") });
  });

  it("enforces the step limit", async () => {
    const nina = await hire();
    await db.update(agents).set({ maxStepsPerRun: 2 }).where(eq(agents.id, nina.id));
    script = [
      { toolCalls: [{ id: "1", name: "inventory_search", input: { query: "a" } }] },
      { toolCalls: [{ id: "2", name: "inventory_search", input: { query: "b" } }] },
      { text: "never reached" },
    ];
    expect(await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "manual" })).toMatchObject({ status: "aborted", steps: expect.any(Number) });
  });

  it("records refusals as failed runs", async () => {
    const nina = await hire();
    script = [{ stopReason: "refusal", stopDetail: "cyber" }];
    expect(await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "manual" })).toMatchObject({
      status: "failed",
      summary: "The model declined the task (cyber).",
    });
  });

  it("skips paused and fired agents, and firing removes skills", async () => {
    const nina = await hire();
    await pauseAgent(db, actor, nina.id);
    expect(await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "manual" })).toMatchObject({ status: "skipped" });
    await fireAgent(db, actor, nina.id);
    expect(await db.select().from(agentSkills).where(eq(agentSkills.agentId, nina.id))).toHaveLength(0);
    expect(await runAgent(deps(), { agentId: nina.id, task: "t", trigger: "manual" })).toMatchObject({ status: "skipped", summary: "Agent is fired" });
    expect(await db.select().from(agentRuns).where(eq(agentRuns.agentId, nina.id))).toHaveLength(0);
  });
});
