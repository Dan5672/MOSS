"use server";

import { writeAudit } from "@moss/core";
import { agentToolOverrides, agents } from "@moss/db";
import { and, eq, ne } from "drizzle-orm";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { toolAccess } from "@/server/tool-catalog";

/**
 * Sets which agents may use a tool. Only differences from what each agent's skills (or a custom tool's
 * direct grant) already give are stored, as per-agent overrides; matching the default clears the override.
 */
export async function setToolAccessAction(tool: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    const { tools } = await toolAccess(user.orgId, 1);
    const entry = tools.find((t) => t.name === tool);
    if (!entry) throw new Error(`Unknown tool ${tool}`);
    const wanted = new Set(form.getAll("agents").map(String));
    const team = await db().select({ id: agents.id }).from(agents).where(and(eq(agents.orgId, user.orgId), ne(agents.status, "fired")));

    const changes: { agentId: string; granted: boolean | null }[] = [];
    for (const { id } of team) {
      const h = entry.holdings.find((x) => x.id === id);
      const base = h?.base ?? false;
      const want = wanted.has(id);
      const current = h?.override === "granted" ? true : h?.override === "removed" ? false : base;
      if (want === current) continue;
      changes.push({ agentId: id, granted: want === base ? null : want });
    }
    await db().transaction(async (tx) => {
      for (const c of changes) {
        const key = and(eq(agentToolOverrides.agentId, c.agentId), eq(agentToolOverrides.tool, tool));
        if (c.granted === null) await tx.delete(agentToolOverrides).where(key);
        else
          await tx
            .insert(agentToolOverrides)
            .values({ agentId: c.agentId, tool, granted: c.granted, setBy: user.id })
            .onConflictDoUpdate({ target: [agentToolOverrides.agentId, agentToolOverrides.tool], set: { granted: c.granted, setBy: user.id, setAt: new Date() } });
      }
    });
    if (changes.length) {
      await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "tool.access", targetType: "tool", targetId: tool, details: { changes } });
    }
    return changes.length ? `Updated who can use ${tool}.` : `No change to ${tool}.`;
  });
}
