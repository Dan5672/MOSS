"use server";

import { agentRuns, agents, runSteps } from "@moss/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

export interface PanelStep {
  kind: "said" | "called" | "result" | "denied" | "error";
  text: string;
}

export interface AgentPanel {
  agent: { id: string; name: string; title: string; status: string };
  run: { id: string; status: string; trigger: string; startedAt: string; endedAt: string | null; summary: string | null } | null;
  steps: PanelStep[];
  canChat: boolean;
}

const cut = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** What an agent is doing (its latest run's last steps), for the Basement's agent panel. */
export async function agentPanelAction(agentId: string): Promise<AgentPanel | null> {
  const user = await requireUser();
  if (!user.permissions.has("agents.read")) return null;
  const [agent] = await db()
    .select({ id: agents.id, name: agents.name, title: agents.title, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, user.orgId)));
  if (!agent) return null;
  const [run] = await db().select().from(agentRuns).where(eq(agentRuns.agentId, agentId)).orderBy(desc(agentRuns.startedAt)).limit(1);
  const rows = run ? await db().select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(desc(runSteps.seq)).limit(12) : [];
  // Step content comes from the model and from tools (untrusted): it is only ever shown as text.
  const steps = rows.reverse().flatMap((s): PanelStep[] => {
    const c = (s.content ?? {}) as Record<string, unknown>;
    if (s.kind === "message") {
      const out: PanelStep[] = [];
      if (typeof c.text === "string" && c.text.trim()) out.push({ kind: "said", text: cut(c.text, 600) });
      for (const t of (Array.isArray(c.toolCalls) ? c.toolCalls : []) as { name?: string; input?: unknown }[]) out.push({ kind: "called", text: `${t.name ?? "?"} ${cut(t.input, 160)}` });
      return out;
    }
    if (s.kind === "tool_result") return [{ kind: c.isError ? "error" : "result", text: `${c.name ?? "tool"}: ${cut(c.content, 200)}` }];
    if (s.kind === "policy_denied") return [{ kind: "denied", text: `${c.name ?? "tool"}: ${cut(c.reason, 200)}` }];
    if (s.kind === "error") return [{ kind: "error", text: cut(c.message, 300) }];
    return [];
  });
  return {
    agent,
    run: run
      ? { id: run.id, status: run.status, trigger: run.trigger, startedAt: run.startedAt.toISOString(), endedAt: run.endedAt?.toISOString() ?? null, summary: run.summary }
      : null,
    steps,
    canChat: user.permissions.has("agents.chat") && agent.status === "active",
  };
}
