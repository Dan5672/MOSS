"use server";

import { CHAT_NAMES, CHAT_PLATFORMS, CHAT_TOKEN_SECRET, chatConfigSchema, createLinkCode, loadChatModule, saveModule, unlinkChat, type ChatPlatform } from "@moss/core";
import { secrets } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission, requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { storeSecret } from "@/server/services";

const on = (v: FormDataEntryValue | null) => v === "on" || v === "true";
const platformOf = (p: string): ChatPlatform => z.enum(CHAT_PLATFORMS).parse(p);
const TOKEN: Record<ChatPlatform, RegExp> = { telegram: /^\d{5,15}:[A-Za-z0-9_-]{30,}$/, discord: /^[A-Za-z0-9._-]{50,100}$/ };

async function hasToken(orgId: string, p: ChatPlatform) {
  const [s] = await db().select({ id: secrets.id }).from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, CHAT_TOKEN_SECRET[p])));
  return !!s;
}

export async function saveChatTokenAction(platform: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    if (!user.permissions.has("secrets.manage")) throw new Error("Storing the bot token also needs permission to manage secrets.");
    const p = platformOf(platform);
    const token = String(form.get("token") ?? "").trim();
    if (!TOKEN[p].test(token)) throw new Error(p === "telegram" ? "That doesn't look like a Telegram bot token (123456789:AA...)." : "That doesn't look like a Discord bot token.");
    // Only the gate decrypts it, for the bridge; no agent tool can use it.
    await storeSecret({ userId: user.id, name: CHAT_TOKEN_SECRET[p], type: "api_token", value: token, description: `${CHAT_NAMES[p]} bot token (${CHAT_NAMES[p]} integration)`, allowedTools: ["chat_bridge"] });
    revalidatePath(`/settings/integrations/${p}`);
    return "Saved the bot token.";
  });
}

export async function setChatEnabledAction(platform: string, enabled: boolean): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const p = platformOf(platform);
    if (enabled && !(await hasToken(user.orgId, p))) throw new Error("Save the bot token first.");
    const { config } = await loadChatModule(db(), user.orgId, p);
    await saveModule(db(), user.orgId, p, { enabled, config }, { type: "user", id: user.id });
    revalidatePath(`/settings/integrations/${p}`);
    return enabled ? `${CHAT_NAMES[p]} is on. The bot starts within a minute.` : `${CHAT_NAMES[p]} is off. The bot has stopped.`;
  });
}

export async function saveChatSettingsAction(platform: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const p = platformOf(platform);
    const f = formObject(form);
    const parsed = chatConfigSchema.safeParse({
      incidents: on(form.get("incidents")),
      minPriority: f.minPriority ?? "P2",
      monitors: on(form.get("monitors")),
      changes: on(form.get("changes")),
      messages: on(form.get("messages")),
      approvals: on(form.get("approvals")),
      mossUrl: f.mossUrl?.replace(/\/+$/, ""),
    });
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    if (f.mossUrl && !parsed.data.mossUrl) throw new Error("MOSS's address should look like https://10.0.0.213");
    const { enabled } = await loadChatModule(db(), user.orgId, p);
    await saveModule(db(), user.orgId, p, { enabled, config: parsed.data }, { type: "user", id: user.id });
    revalidatePath(`/settings/integrations/${p}`);
    return "Saved.";
  });
}

/** An admin disconnects someone's chat account. */
export async function unlinkChatAction(linkId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    await unlinkChat(db(), user.orgId, z.uuid().parse(linkId));
    revalidatePath("/settings/integrations");
    return "Disconnected.";
  });
}

/** A one-time code for the person to send the bot. */
export async function createChatCodeAction(platform: string): Promise<{ code?: string; error?: string }> {
  try {
    const user = await requireUser();
    const p = platformOf(platform);
    if (!(await loadChatModule(db(), user.orgId, p)).enabled) return { error: `${CHAT_NAMES[p]} isn't switched on in Settings → Integrations.` };
    return { code: await createLinkCode(db(), user.orgId, user.id, p) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** A person disconnects their own chat account. */
export async function unlinkMyChatAction(linkId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    await unlinkChat(db(), user.orgId, z.uuid().parse(linkId), user.id);
    revalidatePath("/settings");
    return "Disconnected.";
  });
}
