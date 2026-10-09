"use server";

import { writeAudit } from "@moss/core";
import { agents, providers, secretGrants, secrets } from "@moss/db";
import { parseRange } from "@moss/policy";
import { BUILT_IN_TOOLS } from "@moss/tools";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { storeSecret } from "@/server/services";
import { secretValueProblem } from "@/lib/secret-value";

/** Hosts a secret may be used against. Required: a credential must never go to a device nobody named. */
function hostsFromForm(raw: string | undefined): string[] {
  const hosts = [...new Set((raw ?? "").split(/[\s,]+/).filter(Boolean))];
  if (!hosts.length) throw new Error("Name at least one host or network this secret may be used with, e.g. 10.0.0.1");
  for (const h of hosts) if (!parseRange(h)) throw new Error(`"${h}" isn't an IP address or CIDR`);
  if (hosts.length > 100) throw new Error("At most 100 hosts");
  return hosts;
}

function toolsFromForm(form: FormData): string[] {
  const tools = form.getAll("tools").map(String);
  for (const t of tools) if (!BUILT_IN_TOOLS.has(t)) throw new Error(`Unknown tool ${t}`);
  return tools;
}

async function setGrants(orgId: string, userId: string, secretId: string, agentIds: string[]) {
  const valid = agentIds.length
    ? (await db().select({ id: agents.id }).from(agents).where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))).map((a) => a.id)
    : [];
  await db().transaction(async (tx) => {
    await tx.delete(secretGrants).where(eq(secretGrants.secretId, secretId));
    if (valid.length) await tx.insert(secretGrants).values(valid.map((agentId) => ({ secretId, agentId, grantedBy: userId })));
  });
  return valid;
}

async function ownSecret(orgId: string, id: string) {
  const [row] = await db().select({ id: secrets.id, name: secrets.name }).from(secrets).where(and(eq(secrets.id, id), eq(secrets.orgId, orgId)));
  if (!row) throw new Error("Secret not found");
  const [provider] = await db().select({ name: providers.name }).from(providers).where(eq(providers.apiKeySecretId, id));
  if (provider) throw new Error(`This is the key for the model provider ${provider.name}; manage it on the Models page`);
  return row;
}

const createSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "Name: letters, digits, dot, dash or underscore"),
  type: z.enum(["password", "ssh_key", "api_token", "snmp_community", "other"]),
  value: z.string().min(1, "Enter the secret value").max(64 * 1024),
  username: z.string().trim().max(128).optional(),
  description: z.string().max(500).optional(),
});

/** Creates a secret, or rotates the value of an existing one with the same name. */
export async function saveSecretAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("secrets.manage");
    const f = createSchema.parse(formObject(form));
    // The raw value: formObject keeps it as typed, but check the original so nothing is trimmed on the way.
    const raw = String(form.get("value") ?? "");
    const problem = secretValueProblem(raw, f.type);
    if (problem && !form.get("allowOdd")) {
      throw new Error(`Not saved: ${problem} Paste only the secret itself, or tick "Save it even if it looks unusual" if it really is like that.`);
    }
    if (f.username && f.type !== "password") throw new Error("A username only goes with a password");
    const allowedHosts = hostsFromForm(form.get("hosts")?.toString());
    const allowedTools = toolsFromForm(form);
    // Encrypted by the gate; the web app never keeps the value.
    const id = await storeSecret({ userId: user.id, ...f, value: raw, allowedHosts, allowedTools });
    const granted = await setGrants(user.orgId, user.id, id, form.getAll("agents").map(String));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "secret.grants", targetType: "secret", targetId: id, details: { agents: granted } });
    return `Saved secret:${f.name} (${raw.length} characters${f.username ? `, for ${f.username}` : ""}). Agents use it as secret:${f.name}.`;
  });
}

export async function updateSecretScopeAction(secretId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("secrets.manage");
    const s = await ownSecret(user.orgId, secretId);
    const allowedHosts = hostsFromForm(form.get("hosts")?.toString());
    const allowedTools = toolsFromForm(form);
    const username = form.has("username") ? z.string().trim().max(128).parse(form.get("username") ?? "") || null : undefined;
    await db()
      .update(secrets)
      .set({ allowedHosts, allowedTools, ...(username !== undefined ? { username } : {}), updatedAt: new Date() })
      .where(eq(secrets.id, secretId));
    const granted = await setGrants(user.orgId, user.id, secretId, form.getAll("agents").map(String));
    await writeAudit(db(), {
      orgId: user.orgId,
      actorType: "user",
      actorId: user.id,
      action: "secret.scope",
      targetType: "secret",
      targetId: secretId,
      details: { name: s.name, allowedHosts, allowedTools, agents: granted, ...(username !== undefined ? { username } : {}) },
    });
    return `Updated secret:${s.name}.`;
  });
}

export async function deleteSecretAction(secretId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("secrets.manage");
    const s = await ownSecret(user.orgId, secretId);
    await db().delete(secrets).where(eq(secrets.id, secretId));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "secret.delete", targetType: "secret", targetId: secretId, details: { name: s.name } });
    return `Deleted secret:${s.name}.`;
  });
}
