// Which tools an agent may call. One definition, used by both the gate (network and custom tools) and the
// runtime (MOSS tools), so they can never disagree:
//   tools granted by the agent's skills
//   + enabled custom tools granted to the agent directly
//   + per-agent overrides that grant a tool
//   - per-agent overrides that remove a tool
// A grant here is necessary, not sufficient: the gate still applies network scope, change requests for
// writes and secret scope, and MOSS tools still need the agent's role permission.
import { agentSkills, agentToolOverrides, customToolGrants, customTools, skills, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";

export async function agentToolGrants(db: Database, agentId: string): Promise<Set<string>> {
  const [fromSkills, custom, overrides] = await Promise.all([
    db
      .select({ toolGrants: skills.toolGrants })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(eq(agentSkills.agentId, agentId)),
    db
      .select({ key: customTools.key })
      .from(customToolGrants)
      .innerJoin(customTools, eq(customTools.id, customToolGrants.toolId))
      .where(and(eq(customToolGrants.agentId, agentId), eq(customTools.enabled, true))),
    db.select({ tool: agentToolOverrides.tool, granted: agentToolOverrides.granted }).from(agentToolOverrides).where(eq(agentToolOverrides.agentId, agentId)),
  ]);
  const tools = new Set([...fromSkills.flatMap((r) => r.toolGrants), ...custom.map((c) => c.key)]);
  for (const o of overrides) {
    if (o.granted) tools.add(o.tool);
    else tools.delete(o.tool);
  }
  return tools;
}
