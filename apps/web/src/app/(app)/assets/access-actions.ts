"use server";

import { agentToolGrants, setNetworkStatus, writeAudit } from "@moss/core";
import { agents, agentToolOverrides, assets, secretGrants, secrets } from "@moss/db";
import { contains, parseRange } from "@moss/policy";
import { BUILT_IN_TOOLS } from "@moss/tools";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { secretValueProblem } from "@/lib/secret-value";
import { act, type ActionState } from "@/server/action";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { storeSecret } from "@/server/services";

const setupSchema = z.object({
  allowNetwork: z.string().max(64).optional(),
  mode: z.enum(["look", "new", "existing"]),
  secretName: z.string().optional(),
  type: z.enum(["password", "ssh_key", "api_token", "snmp_community"]).optional(),
  username: z.string().trim().max(128).optional(),
  secretId: z.uuid().optional(),
});

/**
 * The asset access wizard's last step: allow the asset's network if asked, store (or reuse) a credential
 * scoped to just this asset and the chosen tools, give it to the chosen agents, and optionally give those
 * agents the tools too. Each part checks its own permission.
 */
export async function setupAssetAccessAction(assetId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const [asset] = await db().select().from(assets).where(and(eq(assets.id, assetId), eq(assets.orgId, user.orgId)));
    if (!asset?.primaryIp) throw new Error("This asset has no IP address, so agents can't reach it");
    const ip = asset.primaryIp;
    const f = setupSchema.parse(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string" && v !== "")));
    const tools = form.getAll("tools").map(String);
    for (const t of tools) if (!BUILT_IN_TOOLS.has(t)) throw new Error(`Unknown tool ${t}`);
    const agentIds = form.getAll("agents").map(String);
    const done: string[] = [];

    if (f.allowNetwork) {
      if (!user.permissions.has("networks.manage")) throw new Error("You don't have permission to allow networks");
      const range = parseRange(f.allowNetwork);
      const target = parseRange(ip);
      if (!range || !target || !contains(range, target)) throw new Error(`${f.allowNetwork} doesn't contain ${ip}`);
      const row = await setNetworkStatus(db(), user.orgId, { cidr: f.allowNetwork, status: "allowed" }, user.id);
      done.push(`allowed ${row.cidr}`);
    }

    const validAgents = agentIds.length
      ? (await db().select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.orgId, user.orgId), inArray(agents.id, agentIds))))
      : [];

    let secretId: string | null = null;
    let secretName = "";
    if (f.mode === "new") {
      if (!user.permissions.has("secrets.manage")) throw new Error("You don't have permission to store secrets");
      if (!f.type) throw new Error("Choose what kind of credential it is");
      const name = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "Secret name: letters, digits, dot, dash or underscore").parse(f.secretName);
      const value = String(form.get("value") ?? "");
      if (!value) throw new Error("Enter the password, key or token");
      const problem = secretValueProblem(value, f.type);
      if (problem && !form.get("allowOdd")) throw new Error(`Not saved: ${problem} Paste only the secret itself, or tick "Save it even if it looks unusual".`);
      if (f.username && f.type !== "password") throw new Error("A username only goes with a password");
      secretId = await storeSecret({ userId: user.id, name, type: f.type, value, username: f.username, description: `For ${asset.name}`, allowedHosts: [ip], allowedTools: tools });
      secretName = name;
      done.push(`stored secret:${name} (${value.length} characters) for ${ip}`);
    } else if (f.mode === "existing") {
      if (!user.permissions.has("secrets.manage")) throw new Error("You don't have permission to change secrets");
      const [s] = await db().select().from(secrets).where(and(eq(secrets.id, f.secretId ?? ""), eq(secrets.orgId, user.orgId)));
      if (!s) throw new Error("Choose a secret");
      const target = parseRange(ip)!;
      const covered = s.allowedHosts.length === 0 || s.allowedHosts.some((h) => {
        const r = parseRange(h);
        return r && contains(r, target);
      });
      const allowedHosts = covered ? s.allowedHosts : [...s.allowedHosts, ip];
      // An empty tool list means "any tool"; otherwise add the ones picked here.
      const allowedTools = s.allowedTools.length ? [...new Set([...s.allowedTools, ...tools])] : s.allowedTools;
      await db().update(secrets).set({ allowedHosts, allowedTools, updatedAt: new Date() }).where(eq(secrets.id, s.id));
      secretId = s.id;
      secretName = s.name;
      if (!covered) done.push(`secret:${s.name} may now be used with ${ip}`);
    }

    if (secretId && validAgents.length) {
      await db()
        .insert(secretGrants)
        .values(validAgents.map((a) => ({ secretId: secretId!, agentId: a.id, grantedBy: user.id })))
        .onConflictDoNothing();
      done.push(`gave secret:${secretName} to ${validAgents.map((a) => a.name).join(", ")}`);
    }

    if (form.get("grantTools") && tools.length && validAgents.length) {
      if (!user.permissions.has("agents.manage")) throw new Error("You don't have permission to change agents' tools");
      const added: string[] = [];
      for (const a of validAgents) {
        const have = await agentToolGrants(db(), a.id);
        const missing = tools.filter((t) => !have.has(t));
        if (!missing.length) continue;
        await db()
          .insert(agentToolOverrides)
          .values(missing.map((tool) => ({ agentId: a.id, tool, granted: true, setBy: user.id })))
          .onConflictDoUpdate({ target: [agentToolOverrides.agentId, agentToolOverrides.tool], set: { granted: true, setBy: user.id, setAt: new Date() } });
        added.push(`${a.name} (${missing.length})`);
      }
      if (added.length) done.push(`gave tools to ${added.join(", ")}`);
    }

    if (!done.length) return "Nothing to change: agents already have that access.";
    await writeAudit(db(), {
      orgId: user.orgId,
      actorType: "user",
      actorId: user.id,
      action: "asset.access_setup",
      targetType: "asset",
      targetId: assetId,
      details: { ip, mode: f.mode, secret: secretName || null, tools, agents: validAgents.map((a) => a.id), allowNetwork: f.allowNetwork ?? null },
    });
    const text = done.join("; ");
    return `Done: ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  });
}
