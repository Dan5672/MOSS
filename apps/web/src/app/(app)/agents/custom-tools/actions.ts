"use server";

import { setSetting, writeAudit } from "@moss/core";
import { agents, customToolGrants, customTools } from "@moss/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { parseCustomTool } from "@/server/custom-tools";
import { db } from "@/server/db";
import { catalogSource, fetchPublicText, remoteCatalog } from "@/server/tool-library";
import { z } from "zod";

async function setGrants(orgId: string, userId: string, toolId: string, agentIds: string[]) {
  const valid = agentIds.length
    ? (await db().select({ id: agents.id }).from(agents).where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))).map((a) => a.id)
    : [];
  await db().transaction(async (tx) => {
    await tx.delete(customToolGrants).where(eq(customToolGrants.toolId, toolId));
    if (valid.length) await tx.insert(customToolGrants).values(valid.map((agentId) => ({ toolId, agentId, grantedBy: userId })));
  });
  return valid;
}

async function ownTool(orgId: string, id: string) {
  const [row] = await db().select().from(customTools).where(and(eq(customTools.id, id), eq(customTools.orgId, orgId)));
  if (!row) throw new Error("Custom tool not found");
  return row;
}

async function keyTaken(orgId: string, key: string, exceptId?: string) {
  const [row] = await db()
    .select({ id: customTools.id })
    .from(customTools)
    .where(and(eq(customTools.orgId, orgId), eq(customTools.key, key), exceptId ? ne(customTools.id, exceptId) : undefined));
  return !!row;
}

export async function addCustomToolAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("tools.manage");
    const source = String(form.get("source") ?? "");
    const spec = parseCustomTool(source);
    if (await keyTaken(user.orgId, spec.key)) throw new Error(`There is already a custom tool called ${spec.key}`);
    const [row] = await db().insert(customTools).values({ orgId: user.orgId, key: spec.key, spec, source, createdByUserId: user.id }).returning();
    const granted = await setGrants(user.orgId, user.id, row!.id, form.getAll("agents").map(String));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "custom_tool.add", targetType: "custom_tool", targetId: row!.id, details: { key: spec.key, class: spec.class, spec, agents: granted } });
    return `Added ${spec.key}.`;
  });
}

export async function updateCustomToolAction(toolId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("tools.manage");
    const before = await ownTool(user.orgId, toolId);
    const source = String(form.get("source") ?? "");
    const spec = parseCustomTool(source);
    if (await keyTaken(user.orgId, spec.key, toolId)) throw new Error(`There is already a custom tool called ${spec.key}`);
    await db().update(customTools).set({ key: spec.key, spec, source, updatedAt: new Date() }).where(eq(customTools.id, toolId));
    const granted = await setGrants(user.orgId, user.id, toolId, form.getAll("agents").map(String));
    await writeAudit(db(), {
      orgId: user.orgId,
      actorType: "user",
      actorId: user.id,
      action: "custom_tool.update",
      targetType: "custom_tool",
      targetId: toolId,
      details: { from: before.spec, to: spec, agents: granted },
    });
    return `Saved ${spec.key}.`;
  });
}

export async function setCustomToolEnabledAction(toolId: string, enabled: boolean, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("tools.manage");
    const t = await ownTool(user.orgId, toolId);
    await db().update(customTools).set({ enabled, updatedAt: new Date() }).where(eq(customTools.id, toolId));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: enabled ? "custom_tool.enable" : "custom_tool.disable", targetType: "custom_tool", targetId: toolId, details: { key: t.key } });
    return enabled ? `${t.key} turned on.` : `${t.key} turned off.`;
  });
}

export async function deleteCustomToolAction(toolId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("tools.manage");
    const t = await ownTool(user.orgId, toolId);
    await db().delete(customTools).where(eq(customTools.id, toolId));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "custom_tool.delete", targetType: "custom_tool", targetId: toolId, details: { key: t.key, spec: t.spec } });
    return `Deleted ${t.key}.`;
  });
}

/** Saves a definition from the catalog or a URL: validated, switched off and granted to nobody until reviewed. */
async function installDefinition(user: { id: string; orgId: string }, source: string, from: string) {
  const spec = parseCustomTool(source);
  if (await keyTaken(user.orgId, spec.key)) throw new Error(`There is already a custom tool called ${spec.key}`);
  const [row] = await db().insert(customTools).values({ orgId: user.orgId, key: spec.key, spec, source, enabled: false, createdByUserId: user.id }).returning();
  await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "custom_tool.add", targetType: "custom_tool", targetId: row!.id, details: { key: spec.key, class: spec.class, from, spec } });
  return spec;
}

export async function installCatalogToolAction(ref: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("tools.manage");
    const spec = await installDefinition(user, await catalogSource(ref), ref);
    return `Installed ${spec.key}, switched off. Review it below, store its secret if it needs one, then switch it on and grant it.`;
  });
}

export async function importToolFromUrlAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("tools.manage");
    const url = z.string().trim().min(1, "Paste the definition's address").max(500).parse(form.get("url"));
    const spec = await installDefinition(user, await fetchPublicText(url), `url:${url}`);
    return `Imported ${spec.key}, switched off. Review it below before you switch it on.`;
  });
}

export async function setCatalogUrlAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("tools.manage");
    const url = String(form.get("url") ?? "").trim();
    if (url) await remoteCatalog(url); // fails here, with the reason, if it can't be read
    await setSetting(db(), user.orgId, "tools.catalog_url", url);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "settings.update", targetType: "setting", targetId: "tools.catalog_url", details: { url } });
    return url ? "Saved the catalog address." : "Removed the remote catalog.";
  });
}
